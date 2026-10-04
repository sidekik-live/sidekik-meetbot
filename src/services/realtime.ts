import type { FastifyBaseLogger } from 'fastify';
import { EVENT_TYPES, STREAMS, makeEvent, type Bus } from '../contracts/index.js';
import type { ChatMessage, Participant, RealtimeMessage } from '../recall/realtime.js';
import type { SessionRow } from '../store/types.js';
import { sessionTime } from './lifecycle.js';

/** Where the screen share goes (the decoder → perception, DESIGN §4). */
export interface ScreenSink {
  /** One H.264 access unit of the shared screen. */
  frame(h264: Buffer, tMs: number): void;
  /** The screen share stopped; the next one may come from someone else. */
  stop(): void;
  /** The session is over here: release everything. */
  close(): void;
}
export type ScreenSinkFactory = (session: SessionRow, log: FastifyBaseLogger) => ScreenSink;

export type ChatHandler = (live: LiveSession, msg: ChatMessage) => void | Promise<void>;

/** What meetbot knows about a session while Recall streams it. Survives Recall reconnecting. */
export type LiveSession = {
  session: SessionRow;
  log: FastifyBaseLogger;
  /** The participant whose screen share is forwarded, or null before the first one. */
  sharer: number | null;
  sink: ScreenSink | undefined;
  stats: { messages: number; frames: number; ignored: number; speech: number };
  disposeTimer?: NodeJS.Timeout | undefined;
};

export type RealtimeHubDeps = {
  bus: Bus;
  /** The bot's own name: its participant's speech isn't the expert's. */
  botName: string;
  screenSink: ScreenSinkFactory;
  onChat?: ChatHandler;
  /** How long state outlives a dropped socket, since Recall retries every 3 s. */
  graceMs?: number;
};

export type RealtimeHub = ReturnType<typeof createRealtimeHub>;

/**
 * Routes Recall real-time events (DESIGN §1, §4):
 * - `speech_on/off` of anyone but the bot → `sk:speech.signals` `user_speech_start/end`, source `recall`;
 * - `screenshare_on/off` → who is sharing; video frames of type `screenshare` from that participant go
 *   to the screen sink, webcams are ignored. A screen-share frame with nobody tracked adopts its
 *   participant (the socket can open after `screenshare_on`);
 * - `chat_message` → the chat handler.
 */
export function createRealtimeHub(deps: RealtimeHubDeps) {
  const sessions = new Map<string, LiveSession>();
  const graceMs = deps.graceMs ?? 60_000;
  const isBot = (p: Participant) => p.name === deps.botName;

  function dispose(sid: string) {
    const live = sessions.get(sid);
    if (!live) return;
    clearTimeout(live.disposeTimer);
    live.sink?.close();
    sessions.delete(sid);
    live.log.info({ ...live.stats }, 'realtime session closed');
  }

  async function publishSpeech(live: LiveSession, kind: 'user_speech_start' | 'user_speech_end', absolute: string) {
    const parsed = Date.parse(absolute);
    const t_ms = sessionTime(live.session, new Date(Number.isNaN(parsed) ? Date.now() : parsed));
    await deps.bus.publish(
      STREAMS.speech,
      makeEvent({
        type: EVENT_TYPES[STREAMS.speech],
        org_id: live.session.org_id,
        session_id: live.session.id,
        t_ms,
        producer: 'meetbot',
        data: { kind, source: 'recall' },
      }),
    );
    live.stats.speech++;
  }

  function sinkOf(live: LiveSession): ScreenSink {
    live.sink ??= deps.screenSink(live.session, live.log);
    return live.sink;
  }

  return {
    get: (sid: string) => sessions.get(sid),

    /** A socket for this session opened: reuse its state if Recall is reconnecting. */
    open(session: SessionRow, log: FastifyBaseLogger): LiveSession {
      const existing = sessions.get(session.id);
      if (existing) {
        clearTimeout(existing.disposeTimer);
        existing.disposeTimer = undefined;
        return existing;
      }
      const live: LiveSession = {
        session,
        log,
        sharer: null,
        sink: undefined,
        stats: { messages: 0, frames: 0, ignored: 0, speech: 0 },
      };
      sessions.set(session.id, live);
      return live;
    },

    /** The socket closed: keep the state a little longer in case Recall reconnects. */
    release(sid: string) {
      const live = sessions.get(sid);
      if (!live || live.disposeTimer) return;
      live.disposeTimer = setTimeout(() => dispose(sid), graceMs);
      live.disposeTimer.unref();
    },

    dispose,

    async handle(live: LiveSession, msg: RealtimeMessage): Promise<void> {
      live.stats.messages++;
      switch (msg.event) {
        case 'video_separate_h264.data': {
          const { type, participant, buffer, timestamp } = msg.data.data;
          if (type !== 'screenshare' || isBot(participant)) {
            live.stats.ignored++;
            return;
          }
          if (live.sharer === null) {
            live.sharer = participant.id;
            live.log.info({ participant_id: participant.id }, 'screen share picked up from video');
          }
          if (participant.id !== live.sharer) {
            live.stats.ignored++;
            return;
          }
          const parsed = Date.parse(timestamp.absolute);
          sinkOf(live).frame(Buffer.from(buffer, 'base64'), sessionTime(live.session, new Date(Number.isNaN(parsed) ? Date.now() : parsed)));
          live.stats.frames++;
          return;
        }
        case 'participant_events.screenshare_on': {
          const { participant } = msg.data.data;
          if (isBot(participant)) return;
          if (live.sharer !== null && live.sharer !== participant.id) live.sink?.stop();
          live.sharer = participant.id;
          live.log.info({ participant_id: participant.id }, 'screen share started');
          return;
        }
        case 'participant_events.screenshare_off': {
          const { participant } = msg.data.data;
          if (participant.id !== live.sharer) return;
          live.sharer = null;
          live.sink?.stop();
          live.log.info({ participant_id: participant.id }, 'screen share stopped');
          return;
        }
        case 'participant_events.speech_on':
        case 'participant_events.speech_off': {
          const { participant, timestamp } = msg.data.data;
          if (isBot(participant)) return;
          const kind = msg.event === 'participant_events.speech_on' ? 'user_speech_start' : 'user_speech_end';
          await publishSpeech(live, kind, timestamp.absolute).catch((err) =>
            live.log.warn({ err, kind }, 'speech signal not published'),
          );
          return;
        }
        case 'participant_events.chat_message':
          if (isBot(msg.data.data.participant)) return;
          await deps.onChat?.(live, msg);
          return;
      }
    },

    closeAll() {
      for (const sid of [...sessions.keys()]) dispose(sid);
    },
  };
}
