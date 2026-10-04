import type { MeetingBotRow, SessionRow, Store } from './types.js';

export type MemoryData = { sessions: SessionRow[]; bots: MeetingBotRow[] };

/** In-memory store for tests and `pnpm dev:mock`; `data` is exposed for assertions. */
export function memoryStore(seed: Partial<MemoryData> = {}): Store & { data: MemoryData } {
  const data: MemoryData = { sessions: [...(seed.sessions ?? [])], bots: [...(seed.bots ?? [])] };
  return {
    data,
    async getSession(id) {
      return data.sessions.find((s) => s.id === id) ?? null;
    },
    async insertBot(row) {
      if (data.bots.some((b) => b.bot_id === row.bot_id)) throw new Error(`duplicate bot_id ${row.bot_id}`);
      data.bots.push({ ...row });
    },
    async getBot(botId) {
      return data.bots.find((b) => b.bot_id === botId) ?? null;
    },
    async activeBot(sessionId) {
      return [...data.bots].reverse().find((b) => b.session_id === sessionId && b.left_at === null) ?? null;
    },
    async updateBot(botId, patch) {
      const bot = data.bots.find((b) => b.bot_id === botId);
      if (bot) Object.assign(bot, patch);
    },
  };
}
