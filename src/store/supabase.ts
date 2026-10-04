import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import type { MeetingBotRow, SessionRow, Store } from './types.js';

const SESSION_COLUMNS = 'id, org_id, workflow_id, kind, mode, phase, workmap_id, language, started_at, ended_at';
const BOT_COLUMNS = 'org_id, session_id, bot_id, platform, status, joined_at, left_at, error';

function unwrap<T>({ data, error }: { data: T; error: PostgrestError | null }, what: string): T {
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
}

/** Reads `sessions`; writes only `meeting_bots` (ARCHITECTURE §6). */
export function supabaseStore(db: SupabaseClient): Store {
  return {
    async getSession(id) {
      return unwrap(
        await db.from('sessions').select(SESSION_COLUMNS).eq('id', id).maybeSingle<SessionRow>(),
        'get session',
      );
    },

    async insertBot(row) {
      unwrap(await db.from('meeting_bots').insert(row), 'insert meeting bot');
    },

    async getBot(botId) {
      return unwrap(
        await db.from('meeting_bots').select(BOT_COLUMNS).eq('bot_id', botId).maybeSingle<MeetingBotRow>(),
        'get meeting bot',
      );
    },

    async activeBot(sessionId) {
      return unwrap(
        await db
          .from('meeting_bots')
          .select(BOT_COLUMNS)
          .eq('session_id', sessionId)
          .is('left_at', null)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle<MeetingBotRow>(),
        'get active meeting bot',
      );
    },

    async updateBot(botId, patch) {
      unwrap(await db.from('meeting_bots').update(patch).eq('bot_id', botId), 'update meeting bot');
    },
  };
}
