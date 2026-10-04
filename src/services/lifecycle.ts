import {
  EVENT_TYPES,
  STREAMS,
  makeEvent,
  priceUsd,
  type Bus,
  type SessionLifecycle,
} from '../contracts/index.js';
import type { SessionRow } from '../store/types.js';

/** Recall model in PRICE_TABLE: per-participant video needs the web_4_core variant. */
export const RECALL_PRICE_MODEL = 'bot_web_4_core';

/** Milliseconds since the session started, never negative. */
export const sessionTime = (session: Pick<SessionRow, 'started_at'>, at: Date) =>
  Math.max(0, Math.round(at.getTime() - Date.parse(session.started_at)));

export type BotEvent = Extract<SessionLifecycle['event'], 'bot_joined' | 'bot_left' | 'bot_error'>;

/**
 * Publishes a bot lifecycle event. `id` is derived from what caused it (the Recall webhook id), so
 * a redelivered webhook republishes the same event and consumers drop it as a duplicate.
 */
export function publishBotEvent(
  bus: Bus,
  session: SessionRow,
  opts: { id: string; event: BotEvent; at: Date; reason?: string | undefined },
) {
  return bus.publish(
    STREAMS.lifecycle,
    makeEvent({
      id: opts.id,
      type: EVENT_TYPES[STREAMS.lifecycle],
      org_id: session.org_id,
      session_id: session.id,
      t_ms: sessionTime(session, opts.at),
      producer: 'meetbot',
      data: {
        event: opts.event,
        kind: session.kind,
        phase: session.phase,
        workflow_id: session.workflow_id,
        ...(session.workmap_id && { workmap_id: session.workmap_id }),
        mode: session.mode,
        language: session.language,
        ...(opts.reason && { reason: opts.reason }),
      },
    }),
  );
}

/** Publishes the bot's time in the call to `sk:usage` (gateway's cost ledger). */
export function publishRecallUsage(bus: Bus, session: SessionRow, opts: { id: string; hours: number; at: Date }) {
  return bus.publish(
    STREAMS.usage,
    makeEvent({
      id: opts.id,
      type: EVENT_TYPES[STREAMS.usage],
      org_id: session.org_id,
      session_id: session.id,
      t_ms: sessionTime(session, opts.at),
      producer: 'meetbot',
      data: {
        service: 'meetbot',
        vendor: 'recall',
        units: opts.hours,
        unit: 'hours',
        cost_usd: priceUsd('recall', RECALL_PRICE_MODEL, 'hours', opts.hours) ?? 0,
      },
    }),
  );
}
