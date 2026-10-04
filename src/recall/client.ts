import { z } from 'zod';
import { HttpError } from '../errors.js';

/** Realtime events meetbot subscribes to (docs.recall.ai: real-time event payloads). */
export const REALTIME_EVENTS = [
  'video_separate_h264.data',
  'participant_events.speech_on',
  'participant_events.speech_off',
  'participant_events.screenshare_on',
  'participant_events.screenshare_off',
  'participant_events.chat_message',
] as const;

export const BOT_NAME = 'Sidekik (recording)';
export const JOIN_MESSAGE = "Sidekik is recording this session with consent. Say 'off the record' or type /off to pause.";

export type CreateBotInput = {
  sessionId: string;
  meetingUrl: string;
  botName: string;
  /** The agent-host page, with its one-time token: runs as the bot's camera (Output Media). */
  agentHostUrl: string;
  /** Our real-time WebSocket, with the secret in the query. */
  realtimeUrl: string;
};

/**
 * The Create Bot body (DESIGN §3, checked against docs.recall.ai on 2026-10-04):
 * - per-participant H.264 needs the gallery_view_v2 layout and the web_4_core variant;
 * - `retention: null` keeps the media in memory only, so there are no recordings to delete;
 * - `metadata.session_id` comes back on every status webhook and real-time event.
 */
export function createBotBody(input: CreateBotInput) {
  return {
    meeting_url: input.meetingUrl,
    bot_name: input.botName,
    metadata: { session_id: input.sessionId },
    variant: { zoom: 'web_4_core', google_meet: 'web_4_core', microsoft_teams: 'web_4_core' },
    output_media: { camera: { kind: 'webpage', config: { url: input.agentHostUrl } } },
    recording_config: {
      video_mixed_layout: 'gallery_view_v2',
      video_separate_h264: {},
      retention: null,
      realtime_endpoints: [{ type: 'websocket', url: input.realtimeUrl, events: [...REALTIME_EVENTS] }],
    },
    chat: { on_bot_join: { send_to: 'everyone', message: JOIN_MESSAGE } },
  };
}

/**
 * Recall wants a `/` before the query string of a real-time endpoint (HTTP 400 otherwise):
 * wss://bot.sidekik.live/recall/ws/{sid}/?secret=…
 */
export function realtimeUrl(publicUrl: string, sessionId: string, secret: string): string {
  const url = new URL(`recall/ws/${encodeURIComponent(sessionId)}/`, withSlash(publicUrl));
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.searchParams.set('secret', secret);
  return url.href;
}

/** {APP_URL}/agent-host/{sid}?t={one_time_token} */
export function agentHostUrl(appUrl: string, sessionId: string, token: string): string {
  const url = new URL(`agent-host/${encodeURIComponent(sessionId)}`, withSlash(appUrl));
  url.searchParams.set('t', token);
  return url.href;
}

const withSlash = (base: string) => (base.endsWith('/') ? base : `${base}/`);

const BotSchema = z.object({ id: z.string().min(1) });

export interface RecallClient {
  /** Creates a bot that joins the meeting now; returns Recall's bot id. */
  createBot(input: CreateBotInput): Promise<{ id: string }>;
  /** Removes the bot from the call. Irreversible. */
  leaveCall(botId: string): Promise<void>;
}

export type RecallClientOptions = {
  apiKey: string;
  region: string;
  /** Per request; gateway gives the whole POST /internal/bots 3 s. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/** Recall REST API, region-local: https://{region}.recall.ai/api/v1. */
export function httpRecallClient(opts: RecallClientOptions): RecallClient {
  const base = `https://${opts.region}.recall.ai/api/v1/`;
  const timeoutMs = opts.timeoutMs ?? 2500;
  const fetchImpl = opts.fetchImpl ?? fetch;

  async function post(path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchImpl(new URL(path, base), {
        method: 'POST',
        headers: {
          authorization: `Token ${opts.apiKey}`,
          accept: 'application/json',
          ...(body !== undefined && { 'content-type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        throw new HttpError(504, 'recall_timeout', `Recall ${path} timed out after ${timeoutMs} ms`);
      }
      throw new HttpError(502, 'recall_unreachable', `Recall ${path} unreachable`);
    }
    if (!res.ok) {
      // Recall explains 4xx in the body (e.g. a bad meeting URL); keep it short for the logs.
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new HttpError(502, 'recall_error', `Recall ${path} returned ${res.status}${detail && `: ${detail}`}`);
    }
    return res.json().catch(() => undefined);
  }

  return {
    async createBot(input) {
      const parsed = BotSchema.safeParse(await post('bot/', createBotBody(input)));
      if (!parsed.success) throw new HttpError(502, 'recall_bad_response', 'Recall bot/ returned no bot id');
      return { id: parsed.data.id };
    },
    async leaveCall(botId) {
      await post(`bot/${encodeURIComponent(botId)}/leave_call/`);
    },
  };
}
