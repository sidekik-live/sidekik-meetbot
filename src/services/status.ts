import type { FastifyBaseLogger } from 'fastify';
import type { Bus } from '../contracts/index.js';
import type { StatusWebhook } from '../recall/webhook.js';
import type { BotPatch, Store } from '../store/types.js';
import { publishBotEvent, publishRecallUsage, type BotEvent } from './lifecycle.js';

export type StatusHandler = (webhookId: string, payload: StatusWebhook, log: FastifyBaseLogger) => Promise<void>;

/**
 * Maps Recall bot status changes to `meeting_bots` and lifecycle events (DESIGN §2):
 * - `in_call_recording` → `joined_at`, `bot_joined` (the bot is in and its streams are live);
 * - `fatal`, `recording_permission_denied` → `error`, `bot_error` with Recall's sub code as reason;
 * - `call_ended`, `done` or `fatal` → `left_at`, `bot_left`, and the bot's hours to `sk:usage`.
 * Other codes (`joining_call`, `in_waiting_room`, …) only update `status`. Svix may redeliver or
 * reorder webhooks: each transition happens once (guarded by the row), and event ids derive from
 * the webhook id. Events are published before the row is written, so a failed write is retried
 * by Recall and republishes the same ids.
 */
export function createStatusHandler(deps: { store: Store; bus: Bus }): StatusHandler {
  const { store, bus } = deps;

  return async (webhookId, payload, baseLog) => {
    const { code, sub_code, updated_at } = payload.data.data;
    const botId = payload.data.bot.id;
    const bot = await store.getBot(botId);
    if (!bot) {
      baseLog.info({ bot_id: botId, code }, 'status for a bot we did not create; ignored');
      return;
    }
    const log = baseLog.child({ session_id: bot.session_id, org_id: bot.org_id, bot_id: botId });
    const session = await store.getSession(bot.session_id);
    const parsed = Date.parse(updated_at);
    const at = new Date(Number.isNaN(parsed) ? Date.now() : parsed);
    const iso = at.toISOString();

    const patch: BotPatch = { status: code };
    const events: { event: BotEvent; reason?: string }[] = [];
    let hours: number | undefined;

    const joined = bot.joined_at !== null;
    const left = bot.left_at !== null;
    if (code === 'in_call_recording' && !joined && !left) {
      patch.joined_at = iso;
      events.push({ event: 'bot_joined' });
    }
    if (code === 'fatal' || code === 'recording_permission_denied') {
      const reason = sub_code ?? code;
      if (bot.error !== reason) {
        patch.error = reason;
        events.push({ event: 'bot_error', reason });
      }
    }
    if ((code === 'call_ended' || code === 'done' || code === 'fatal') && !left) {
      patch.left_at = iso;
      events.push({ event: 'bot_left', reason: sub_code ?? code });
      // Billed from when the bot started recording; a bot that never got in costs nothing here.
      if (bot.joined_at) hours = Math.max(0, at.getTime() - Date.parse(bot.joined_at)) / 3_600_000;
    }

    if (session && session.mode !== 'replay') {
      for (const e of events) {
        await publishBotEvent(bus, session, { id: `${webhookId}:${e.event}`, event: e.event, at, reason: e.reason });
      }
      if (hours !== undefined && hours > 0) await publishRecallUsage(bus, session, { id: `${webhookId}:usage`, hours, at });
    } else if (events.length > 0) {
      log.warn({ code }, 'no live session for this bot; lifecycle not published');
    }
    await store.updateBot(botId, patch);
    log.info({ code, sub_code, events: events.map((e) => e.event), ...(hours !== undefined && { hours }) }, 'bot status');
  };
}
