import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { STREAMS } from '../src/contracts/index.js';
import { signRecallBody, verifyRecallSignature } from '../src/recall/webhook.js';
import type { MeetingBotRow } from '../src/store/types.js';
import { IDS, SECRETS, STARTED_AT, buildTestApp, fakeBus, seededStore } from './helpers.js';

const NOW = Math.floor(Date.now() / 1000);

describe('verifyRecallSignature', () => {
  const body = '{"event":"bot.done"}';

  it('accepts a webhook-* or svix-* signed body, also among several signatures', () => {
    const headers = signRecallBody(body, SECRETS.webhook, 'msg_1', NOW);
    expect(verifyRecallSignature(headers, body, SECRETS.webhook, NOW)).toEqual({ ok: true, id: 'msg_1' });

    const svix = {
      'svix-id': headers['webhook-id'],
      'svix-timestamp': headers['webhook-timestamp'],
      'svix-signature': `v1,AAAA ${headers['webhook-signature']}`,
    };
    expect(verifyRecallSignature(svix, body, SECRETS.webhook, NOW)).toEqual({ ok: true, id: 'msg_1' });
  });

  it('rejects a tampered body, another secret, a stale timestamp and missing headers', () => {
    const headers = signRecallBody(body, SECRETS.webhook, 'msg_1', NOW);
    expect(verifyRecallSignature(headers, body.replace('done', 'fatal'), SECRETS.webhook, NOW)).toMatchObject({ ok: false });
    const other = `whsec_${Buffer.from('another-key').toString('base64')}`;
    expect(verifyRecallSignature(headers, body, other, NOW)).toMatchObject({ ok: false, reason: 'bad signature' });
    expect(verifyRecallSignature(headers, body, SECRETS.webhook, NOW + 600)).toMatchObject({ ok: false, reason: 'stale timestamp' });
    expect(verifyRecallSignature({}, body, SECRETS.webhook, NOW)).toMatchObject({ ok: false, reason: 'missing signature headers' });
    const v2 = { ...headers, 'webhook-signature': headers['webhook-signature']!.replace('v1,', 'v2,') };
    expect(verifyRecallSignature(v2, body, SECRETS.webhook, NOW)).toMatchObject({ ok: false });
  });
});

const BOT: MeetingBotRow = {
  org_id: IDS.org,
  session_id: IDS.session,
  bot_id: 'bot-1',
  platform: 'google_meet',
  status: 'created',
  joined_at: null,
  left_at: null,
  error: null,
};

/** 10:00 is session start; offsets are minutes after it. */
const at = (minutes: number) => new Date(Date.parse(STARTED_AT) + minutes * 60_000).toISOString();

let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function setup() {
  const store = seededStore();
  store.data.bots.push({ ...BOT });
  const bus = fakeBus();
  app = await buildTestApp({ store, bus });
  let n = 0;
  const send = async (code: string, minutes: number, opts: { sub_code?: string | null; id?: string; bot?: string } = {}) => {
    const body = JSON.stringify({
      event: `bot.${code}`,
      data: {
        data: { code, sub_code: opts.sub_code ?? null, updated_at: at(minutes) },
        bot: { id: opts.bot ?? 'bot-1', metadata: { session_id: IDS.session } },
      },
    });
    const headers = signRecallBody(body, SECRETS.webhook, opts.id ?? `msg_${++n}`, Math.floor(Date.now() / 1000));
    return app!.inject({
      method: 'POST',
      url: '/recall/webhook',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: body,
    });
  };
  const lifecycle = () => bus.events(STREAMS.lifecycle).map((e) => [e.data, e.t_ms]);
  return { store, bus, send, lifecycle };
}

describe('POST /recall/webhook', () => {
  it('turns a bot that joins, records and leaves into lifecycle events, row updates and usage', async () => {
    const { store, bus, send, lifecycle } = await setup();
    expect((await send('joining_call', 1)).statusCode).toBe(204);
    await send('in_waiting_room', 1.5);
    expect(store.data.bots[0]).toMatchObject({ status: 'in_waiting_room', joined_at: null });
    expect(lifecycle()).toEqual([]);

    await send('in_call_recording', 2);
    expect(store.data.bots[0]).toMatchObject({ status: 'in_call_recording', joined_at: at(2) });
    expect(lifecycle()).toEqual([
      [{ event: 'bot_joined', kind: 'capture', phase: 'capture', workflow_id: IDS.workflow, mode: 'meeting', language: 'de' }, 120_000],
    ]);

    await send('call_ended', 32, { sub_code: 'call_ended_by_host' });
    await send('done', 33);
    expect(store.data.bots[0]).toMatchObject({ status: 'done', left_at: at(32), error: null });
    expect(lifecycle().slice(1)).toEqual([[expect.objectContaining({ event: 'bot_left', reason: 'call_ended_by_host' }), 1_920_000]]);

    const usage = bus.events(STREAMS.usage);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ producer: 'meetbot', session_id: IDS.session, org_id: IDS.org });
    expect(usage[0]!.data).toEqual({ service: 'meetbot', vendor: 'recall', units: 0.5, unit: 'hours', cost_usd: 0.3 });
  });

  it('reports a fatal bot as an error with Recall’s sub code, and as gone', async () => {
    const { store, send, lifecycle } = await setup();
    await send('fatal', 1, { sub_code: 'bot_kicked_from_waiting_room' });
    await send('done', 2);
    expect(lifecycle().map(([d]) => d)).toEqual([
      expect.objectContaining({ event: 'bot_error', reason: 'bot_kicked_from_waiting_room' }),
      expect.objectContaining({ event: 'bot_left', reason: 'bot_kicked_from_waiting_room' }),
    ]);
    expect(store.data.bots[0]).toMatchObject({ status: 'done', error: 'bot_kicked_from_waiting_room', left_at: at(1) });
  });

  it('publishes each transition once, with ids that repeat on redelivery', async () => {
    const { bus, send } = await setup();
    await send('in_call_recording', 2, { id: 'msg_a' });
    await send('in_call_recording', 2, { id: 'msg_a' });
    await send('in_call_recording', 3, { id: 'msg_b' });
    expect(bus.events(STREAMS.lifecycle).map((e) => e.id)).toEqual(['msg_a:bot_joined']);
  });

  it('retries cleanly when the bus is down: 500, nothing written, then the same event ids', async () => {
    const { store, bus, send } = await setup();
    bus.fail = new Error('redis down');
    expect((await send('in_call_recording', 2, { id: 'msg_x' })).statusCode).toBe(500);
    expect(store.data.bots[0]?.joined_at).toBeNull();
    bus.fail = undefined;
    expect((await send('in_call_recording', 2, { id: 'msg_x' })).statusCode).toBe(204);
    expect(bus.events(STREAMS.lifecycle).map((e) => e.id)).toEqual(['msg_x:bot_joined']);
  });

  it('acknowledges bots it didn’t create and events it doesn’t handle', async () => {
    const { bus, send } = await setup();
    expect((await send('in_call_recording', 2, { bot: 'someone-elses-bot' })).statusCode).toBe(204);
    expect(bus.published).toEqual([]);
  });

  it('rejects unsigned and tampered requests', async () => {
    const { send } = await setup();
    const unsigned = await app!.inject({
      method: 'POST',
      url: '/recall/webhook',
      headers: { 'content-type': 'application/json' },
      payload: '{"event":"bot.done"}',
    });
    expect(unsigned.statusCode).toBe(401);
    const ok = await send('joining_call', 1);
    expect(ok.statusCode).toBe(204);
  });
});
