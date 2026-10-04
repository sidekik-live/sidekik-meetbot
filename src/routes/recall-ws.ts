import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { RawData } from 'ws';
import { parseRealtimeMessage } from '../recall/realtime.js';
import type { RealtimeHub } from '../services/realtime.js';
import type { SessionRow, Store } from '../store/types.js';

export type RecallWsOptions = { store: Store; hub: RealtimeHub; secret: string; pingMs?: number };

const sameSecret = (given: string | undefined, expected: string) => {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * `WS /recall/ws/:sid/?secret=` (public): Recall's real-time endpoint for one bot (DESIGN §2).
 * The secret is the one we put in the URL at bot creation. Recall sends JSON text messages; we
 * ping every 30 s so proxies (Cloudflare) don't drop an idle socket.
 */
export const recallWsRoutes: FastifyPluginAsync<RecallWsOptions> = async (app, opts) => {
  const sessionOf = new WeakMap<object, SessionRow>();

  app.get<{ Params: { sid: string }; Querystring: { secret?: string } }>(
    '/recall/ws/:sid',
    {
      websocket: true,
      preValidation: async (request, reply) => {
        if (!sameSecret(request.query.secret, opts.secret)) {
          request.log.warn({ session_id: request.params.sid }, 'recall ws: bad secret');
          return reply.code(401).send({ error: 'unauthorized' });
        }
        const session = await opts.store.getSession(request.params.sid);
        if (!session || session.ended_at || session.mode !== 'meeting') {
          request.log.warn({ session_id: request.params.sid }, 'recall ws: no live meeting session');
          return reply.code(404).send({ error: 'not_found' });
        }
        sessionOf.set(request, session);
      },
    },
    (socket, request) => {
      const session = sessionOf.get(request)!;
      const log = request.log.child({ session_id: session.id, org_id: session.org_id });
      const live = opts.hub.open(session, log);
      log.info('recall ws: connected');

      const ping = setInterval(() => socket.ping(), opts.pingMs ?? 30_000);
      ping.unref();

      // Messages are handled one at a time, in order; video never waits on the bus.
      let chain = Promise.resolve();
      socket.on('message', (data: RawData, isBinary: boolean) => {
        if (isBinary) return;
        const msg = parseRealtimeMessage(data.toString());
        if (!msg) {
          live.stats.ignored++;
          return;
        }
        if (msg.event === 'video_separate_h264.data') {
          void opts.hub.handle(live, msg);
          return;
        }
        chain = chain.then(() => opts.hub.handle(live, msg)).catch((err) => log.warn({ err }, 'recall ws: handler failed'));
      });

      socket.on('close', (code: number) => {
        clearInterval(ping);
        log.info({ code, ...live.stats }, 'recall ws: closed');
        opts.hub.release(session.id);
      });
    },
  );
};
