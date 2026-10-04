import type { FastifyPluginAsync } from 'fastify';
import { StatusWebhookSchema, verifyRecallSignature } from '../recall/webhook.js';
import type { StatusHandler } from '../services/status.js';

export type RecallWebhookOptions = { secret: string; onStatus: StatusHandler };

/**
 * `POST /recall/webhook` (public): Recall bot status changes, delivered by Svix and signed with the
 * workspace verification secret. Unsigned or tampered requests get 401. Recall wants a 2xx within
 * 15 s; a 500 makes Svix retry.
 */
export const recallWebhookRoutes: FastifyPluginAsync<RecallWebhookOptions> = async (app, opts) => {
  // The signature covers the exact bytes, so this route keeps the raw body (encapsulated parser).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => done(null, body));

  app.post('/recall/webhook', { bodyLimit: 256 * 1024 }, async (request, reply) => {
    const raw = typeof request.body === 'string' ? request.body : '';
    const verified = verifyRecallSignature(request.headers, raw, opts.secret);
    if (!verified.ok) {
      request.log.warn({ reason: verified.reason }, 'recall webhook rejected');
      return reply.code(401).send({ error: 'unauthorized', message: 'Invalid webhook signature' });
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return reply.code(400).send({ error: 'bad_request', message: 'Body is not valid JSON' });
    }
    const parsed = StatusWebhookSchema.safeParse(json);
    if (!parsed.success) {
      // Other subscribed events (e.g. recording.*) aren't ours to handle; acknowledge them.
      request.log.info({ event: (json as { event?: unknown })?.event }, 'recall webhook ignored');
      return reply.code(204).send();
    }
    if (!parsed.data.event.startsWith('bot.')) return reply.code(204).send();

    await opts.onStatus(verified.id, parsed.data, request.log);
    return reply.code(204).send();
  });
};
