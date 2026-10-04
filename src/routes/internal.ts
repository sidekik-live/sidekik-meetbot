import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { CreateBotRequestSchema, internalAuth } from '../contracts/index.js';
import { HttpError, notFound } from '../errors.js';
import type { BotService } from '../services/bots.js';
import type { Store } from '../store/types.js';

export type InternalRoutesOptions = { store: Store; bots: BotService; internalToken: string };

/** Gateway → meetbot (DESIGN §2), `X-Internal-Token`, 3 s budget. */
export const internalRoutes: FastifyPluginAsyncZod<InternalRoutesOptions> = async (app, opts) => {
  const { store, bots } = opts;
  app.addHook('onRequest', internalAuth(opts.internalToken));

  app.post('/internal/bots', { schema: { body: CreateBotRequestSchema } }, async (request, reply) => {
    const { session_id, meeting_url, bot_name } = request.body;
    const session = await store.getSession(session_id);
    if (!session) throw notFound('Session not found');
    const log = request.log.child({ session_id: session.id, org_id: session.org_id });
    if (session.ended_at) throw new HttpError(409, 'session_ended', 'Session has ended');
    if (session.mode !== 'meeting') throw new HttpError(409, 'not_meeting_session', 'Session was not started in meeting mode');

    const { bot_id, created } = await bots.create(session, meeting_url, bot_name, log);
    return reply.code(created ? 201 : 200).send({ bot_id });
  });

  app.delete(
    '/internal/bots/:sid',
    { schema: { params: z.object({ sid: z.string().min(1) }) } },
    async (request, reply) => {
      const session = await store.getSession(request.params.sid);
      const log = request.log.child({ session_id: request.params.sid, ...(session && { org_id: session.org_id }) });
      await bots.remove(request.params.sid, log);
      return reply.code(204).send();
    },
  );
};
