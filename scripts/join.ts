// Manual test (DESIGN §7 ticket 7): send the session's bot into a meeting through a running meetbot,
// then watch Recall's status until the bot is done. Ctrl+C takes the bot out of the call.
//
//   pnpm join <meeting-url> --session <session-id>    # a live, meeting-mode session (gateway: POST /v1/sessions)
//   pnpm join --leave <session-id>
//
// Reads .env: SK_INTERNAL_TOKEN, and RECALL_API_KEY + RECALL_REGION to watch the status (optional).
// MEETBOT_URL defaults to http://localhost:$PORT. Recall must reach PUBLIC_URL (use a tunnel locally).
import { parseArgs } from 'node:util';
import { httpRecallClient } from '../src/recall/client.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { session: { type: 'string', short: 's' }, leave: { type: 'string' } },
});

const token = process.env.SK_INTERNAL_TOKEN;
if (!token) fail('SK_INTERNAL_TOKEN is not set (.env)');
const meetbot = process.env.MEETBOT_URL ?? `http://localhost:${process.env.PORT ?? 8086}`;
const headers = { 'x-internal-token': token, 'content-type': 'application/json' };

if (values.leave) {
  await leave(values.leave);
  process.exit(0);
}

const meetingUrl = positionals[0];
const sessionId = values.session;
if (!meetingUrl || !sessionId) fail('usage: pnpm join <meeting-url> --session <session-id>  |  pnpm join --leave <session-id>');

const res = await fetch(`${meetbot}/internal/bots`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ session_id: sessionId, meeting_url: meetingUrl }),
});
const body = (await res.json().catch(() => ({}))) as { bot_id?: string; error?: string; message?: string };
if (!res.ok || !body.bot_id) fail(`meetbot answered ${res.status}: ${body.error ?? ''} ${body.message ?? ''}`);
console.log(`${res.status === 201 ? 'bot created' : 'session already has a bot'}: ${body.bot_id}`);
console.log('admit "Sidekik (recording)" in the meeting; Ctrl+C removes it');

process.once('SIGINT', async () => {
  await leave(sessionId);
  process.exit(0);
});

const { RECALL_API_KEY: apiKey, RECALL_REGION: region } = process.env;
if (!apiKey || !region) {
  console.log('RECALL_API_KEY / RECALL_REGION not set: not watching the status');
} else {
  const recall = httpRecallClient({ apiKey, region, timeoutMs: 5000 });
  let seen = 0;
  for (;;) {
    const changes = await recall.statusChanges(body.bot_id).catch((err: Error) => {
      console.warn(`status check failed: ${err.message}`);
      return null;
    });
    for (const c of changes?.slice(seen) ?? []) {
      console.log(`${c.created_at}  ${c.code}${c.sub_code ? ` (${c.sub_code})` : ''}`);
    }
    seen = changes?.length ?? seen;
    const last = changes?.at(-1)?.code;
    if (last === 'done' || last === 'fatal') break;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function leave(sid: string) {
  const r = await fetch(`${meetbot}/internal/bots/${encodeURIComponent(sid)}`, { method: 'DELETE', headers: { 'x-internal-token': token! } });
  console.log(r.ok ? 'bot asked to leave' : `leave failed: ${r.status}`);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
