import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyServerOptions } from 'fastify';
import websocket from '@fastify/websocket';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { STREAMS, type Bus } from './contracts/index.js';
import type { Env } from './env.js';
import { HttpError } from './errors.js';
import { BOT_NAME, type RecallClient } from './recall/client.js';
import { healthRoutes, type HealthCheck } from './routes/health.js';
import { internalRoutes } from './routes/internal.js';
import { recallWebhookRoutes } from './routes/recall-webhook.js';
import { recallWsRoutes } from './routes/recall-ws.js';
import { createBotService } from './services/bots.js';
import type { GatewayClient } from './services/gateway.js';
import { chatCommands } from './services/chat.js';
import { OffRecordState } from './services/off-record.js';
import { createRealtimeHub, type ScreenSinkFactory } from './services/realtime.js';
import { createStatusHandler } from './services/status.js';
import type { Store } from './store/types.js';
import { VERSION } from './version.js';

export type AppDeps = {
  env: Env;
  recall: RecallClient;
  gateway: GatewayClient;
  store: Store;
  bus: Bus;
  /** Where screen-share video goes; defaults to dropping it. */
  screenSink?: ScreenSinkFactory;
  /** Shared with the screen pipeline, which stops sending frames while a session is off. */
  offRecord?: OffRecordState;
  healthChecks: Record<string, HealthCheck>;
  /** The service's shared pino logger (server, dev:mock); tests pass `logger` options instead. */
  loggerInstance?: FastifyBaseLogger;
  logger?: FastifyServerOptions['logger'];
};

export async function buildApp(deps: AppDeps) {
  const { env } = deps;
  const logger = deps.logger ?? { level: env.LOG_LEVEL };
  const app = Fastify({
    ...(deps.loggerInstance
      ? { loggerInstance: deps.loggerInstance }
      : {
          logger:
            typeof logger === 'object'
              ? { ...logger, base: { service: 'sidekik-meetbot', version: VERSION, pid: process.pid } }
              : logger,
        }),
    // Recall calls /recall/ws/:sid/ with the trailing slash it requires; routes are declared without it.
    routerOptions: { ignoreTrailingSlash: true },
    // Cloudflare → Railway: trust X-Forwarded-* for client IPs.
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler<FastifyError>((err, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({
        error: 'bad_request',
        message: 'Request validation failed',
        issues: err.validation.map((v) => ({ path: v.instancePath, message: v.message })),
      });
    }
    if (err instanceof HttpError) {
      if (err.statusCode >= 500) request.log.warn({ err }, err.message);
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err }, 'unhandled error');
      return reply.code(500).send({ error: 'internal_error', message: 'Internal Server Error' });
    }
    return reply.code(status).send({ error: err.code ?? 'error', message: err.message });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ error: 'not_found', message: `Route ${request.method} ${request.url} not found` }),
  );

  // Recall sends one H.264 access unit per message; a screen-share keyframe can be a few hundred KB.
  await app.register(websocket, { options: { maxPayload: 8 * 1024 * 1024 } });

  const bots = createBotService({ env, store: deps.store, recall: deps.recall, gateway: deps.gateway });
  const offRecord = deps.offRecord ?? new OffRecordState();
  const hub = createRealtimeHub({
    bus: deps.bus,
    botName: BOT_NAME,
    screenSink: deps.screenSink ?? (() => ({ frame() {}, stop() {}, close() {} })),
    onChat: chatCommands({ gateway: deps.gateway, offRecord }),
    onOpen: (session) => {
      if (session.off_record) offRecord.set(session.id, true);
    },
  });

  // Bus consumers start once the app is ready and stop when it closes.
  const stops: (() => void)[] = [];
  app.addHook('onReady', async () => {
    stops.push(
      deps.bus.consume(STREAMS.lifecycle, async (ev) => {
        if (ev.data.mode === 'replay') return;
        if (ev.data.event === 'offrecord_on' || ev.data.event === 'offrecord_off') {
          offRecord.set(ev.session_id, ev.data.event === 'offrecord_on');
          hub.get(ev.session_id)?.log.info({ off_record: ev.data.event === 'offrecord_on' }, 'off-record changed');
        }
        if (ev.data.event === 'ended') {
          hub.dispose(ev.session_id);
          offRecord.forget(ev.session_id);
        }
      }),
    );
  });
  app.addHook('onClose', async () => {
    for (const stop of stops.splice(0)) stop();
    hub.closeAll();
  });

  await app.register(healthRoutes, { version: VERSION, checks: deps.healthChecks });
  await app.register(internalRoutes, { store: deps.store, bots, internalToken: env.SK_INTERNAL_TOKEN });
  await app.register(recallWebhookRoutes, {
    secret: env.RECALL_WEBHOOK_SECRET,
    onStatus: createStatusHandler({ store: deps.store, bus: deps.bus }),
  });
  await app.register(recallWsRoutes, { store: deps.store, hub, secret: env.RECALL_WS_SECRET });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
