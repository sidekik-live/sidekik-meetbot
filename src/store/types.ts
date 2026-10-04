import type { Phase, SessionKind, SessionMode } from '../contracts/index.js';

/** The `sessions` columns meetbot reads (owned by gateway). */
export type SessionRow = {
  id: string;
  org_id: string;
  workflow_id: string;
  kind: SessionKind;
  mode: SessionMode;
  phase: Phase;
  workmap_id: string | null;
  language: string;
  started_at: string;
  ended_at: string | null;
};

export type Platform = 'google_meet' | 'zoom' | 'teams' | 'unknown';

/** A `meeting_bots` row (SCHEMA.md 0003, owned by meetbot). `status` is Recall's latest status code. */
export type MeetingBotRow = {
  org_id: string;
  session_id: string;
  bot_id: string;
  platform: Platform;
  status: string;
  joined_at: string | null;
  left_at: string | null;
  error: string | null;
};

export type BotPatch = Partial<Pick<MeetingBotRow, 'status' | 'joined_at' | 'left_at' | 'error'>>;

export interface Store {
  getSession(id: string): Promise<SessionRow | null>;
  insertBot(row: MeetingBotRow): Promise<void>;
  getBot(botId: string): Promise<MeetingBotRow | null>;
  /** The session's newest bot that hasn't left the call. */
  activeBot(sessionId: string): Promise<MeetingBotRow | null>;
  updateBot(botId: string, patch: BotPatch): Promise<void>;
}
