import type { GatewayClient } from './gateway.js';
import type { OffRecordState } from './off-record.js';
import type { ChatHandler } from './realtime.js';

/** `/off` or `/on` at the start of a chat message, any case. */
const COMMAND = /^\s*\/(off|on)\b/i;

/**
 * Meeting chat commands (DESIGN §4): `/off` and `/on` set the session off or back on the record
 * through gateway, which records the span and tells every service. Frames stop here at once, before
 * gateway's lifecycle event comes back.
 */
export function chatCommands(deps: { gateway: GatewayClient; offRecord: OffRecordState }): ChatHandler {
  return async (live, msg) => {
    const text = msg.data.data.data?.text ?? '';
    const match = COMMAND.exec(text);
    if (!match) return;
    const on = match[1]!.toLowerCase() === 'off';
    try {
      await deps.gateway.offRecord(live.session.id, on);
      deps.offRecord.set(live.session.id, on);
      live.log.info({ off_record: on, participant_id: msg.data.data.participant.id }, 'chat command');
    } catch (err) {
      live.log.warn({ err, off_record: on }, 'chat command failed');
    }
  };
}
