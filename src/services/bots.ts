import type { FastifyBaseLogger } from 'fastify';
import type { Env } from '../env.js';
import { agentHostUrl, realtimeUrl, type RecallClient } from '../recall/client.js';
import type { Platform, SessionRow, Store } from '../store/types.js';
import type { GatewayClient } from './gateway.js';

/** Meeting platform from the meeting URL's host (`meeting_bots.platform`). */
export function platformOf(meetingUrl: string): Platform {
  const host = new URL(meetingUrl).hostname;
  if (host === 'meet.google.com') return 'google_meet';
  if (host === 'zoom.us' || host.endsWith('.zoom.us')) return 'zoom';
  if (host === 'teams.microsoft.com' || host === 'teams.live.com' || host.endsWith('.teams.microsoft.com')) return 'teams';
  return 'unknown';
}

export type BotServiceDeps = {
  env: Pick<Env, 'APP_URL' | 'PUBLIC_URL' | 'RECALL_WS_SECRET'>;
  store: Store;
  recall: RecallClient;
  gateway: GatewayClient;
};

export type BotService = ReturnType<typeof createBotService>;

/** Sends bots into meetings and takes them out again (DESIGN §2–3). One live bot per session. */
export function createBotService(deps: BotServiceDeps) {
  const { env, store, recall, gateway } = deps;
  // A retried POST must not send a second bot while the first request is still talking to Recall.
  const inFlight = new Map<string, Promise<{ bot_id: string; created: boolean }>>();

  async function create(session: SessionRow, meetingUrl: string, botName: string, log: FastifyBaseLogger) {
    const existing = await store.activeBot(session.id);
    if (existing) {
      log.info({ bot_id: existing.bot_id, status: existing.status }, 'session already has a bot');
      return { bot_id: existing.bot_id, created: false };
    }
    const t = await gateway.agentHostToken(session.id);
    const bot = await recall.createBot({
      sessionId: session.id,
      meetingUrl,
      botName,
      agentHostUrl: agentHostUrl(env.APP_URL, session.id, t),
      realtimeUrl: realtimeUrl(env.PUBLIC_URL, session.id, env.RECALL_WS_SECRET),
    });
    const platform = platformOf(meetingUrl);
    await store.insertBot({
      org_id: session.org_id,
      session_id: session.id,
      bot_id: bot.id,
      platform,
      status: 'created',
      joined_at: null,
      left_at: null,
      error: null,
    });
    log.info({ bot_id: bot.id, platform }, 'meeting bot created');
    return { bot_id: bot.id, created: true };
  }

  return {
    create(session: SessionRow, meetingUrl: string, botName: string, log: FastifyBaseLogger) {
      const pending = inFlight.get(session.id);
      if (pending) return pending.then((r) => ({ ...r, created: false }));
      const p = create(session, meetingUrl, botName, log).finally(() => inFlight.delete(session.id));
      inFlight.set(session.id, p);
      return p;
    },

    /** Asks Recall to take the session's bot out of the call; `left_at` follows from the status webhook. */
    async remove(sessionId: string, log: FastifyBaseLogger): Promise<string | null> {
      const bot = await store.activeBot(sessionId);
      if (!bot) {
        log.info('no active meeting bot to remove');
        return null;
      }
      await recall.leaveCall(bot.bot_id);
      await store.updateBot(bot.bot_id, { status: 'leave_requested' });
      log.info({ bot_id: bot.bot_id }, 'meeting bot asked to leave');
      return bot.bot_id;
    },
  };
}
