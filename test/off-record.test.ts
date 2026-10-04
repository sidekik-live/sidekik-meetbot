import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { App } from '../src/app.js';
import { EVENT_TYPES, STREAMS, makeEvent, type SessionLifecycle } from '../src/contracts/index.js';
import { HttpError } from '../src/errors.js';
import { OffRecordState } from '../src/services/off-record.js';
import { IDS, SECRETS, STARTED_AT, buildTestApp, fakeBus, fakeGateway, seededStore } from './helpers.js';

const EXPERT = { id: 100, name: 'Sabine', is_host: true };
const ts = (s: number) => ({ absolute: new Date(Date.parse(STARTED_AT) + s * 1000).toISOString(), relative: s });
const chat = (participant: object, text: string) => ({
  event: 'participant_events.chat_message',
  data: { data: { participant, timestamp: ts(1), data: { text, to: 'everyone' } }, bot: { id: 'bot-1', metadata: {} } },
});

const lifecycle = (event: SessionLifecycle['event'], mode: SessionLifecycle['mode'] = 'meeting') =>
  makeEvent<SessionLifecycle>({
    type: EVENT_TYPES[STREAMS.lifecycle],
    org_id: IDS.org,
    session_id: IDS.session,
    t_ms: 5000,
    producer: 'gateway',
    data: { event, kind: 'capture', phase: 'capture', workflow_id: IDS.workflow, mode, language: 'de' },
  });

let app: App | undefined;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await app?.close();
  app = undefined;
});

async function setup(opts: { offRecordInRow?: boolean } = {}) {
  const store = seededStore();
  if (opts.offRecordInRow) store.data.sessions[0]!.off_record = true;
  const bus = fakeBus();
  const gateway = fakeGateway();
  const offRecord = new OffRecordState();
  app = await buildTestApp({ store, bus, gateway, offRecord });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  const connect = () =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/recall/ws/${IDS.session}/?secret=${SECRETS.ws}`);
      sockets.push(ws);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  return { bus, gateway, offRecord, connect };
}

describe('off the record', () => {
  it('follows lifecycle offrecord_on/off, and ignores replays', async () => {
    const { bus, offRecord } = await setup();
    await bus.deliver(STREAMS.lifecycle, lifecycle('offrecord_on'));
    expect(offRecord.isOff(IDS.session)).toBe(true);
    await bus.deliver(STREAMS.lifecycle, lifecycle('offrecord_off', 'replay'));
    expect(offRecord.isOff(IDS.session)).toBe(true);
    await bus.deliver(STREAMS.lifecycle, lifecycle('offrecord_off'));
    expect(offRecord.isOff(IDS.session)).toBe(false);
    await bus.deliver(STREAMS.lifecycle, lifecycle('offrecord_on'));
    await bus.deliver(STREAMS.lifecycle, lifecycle('ended'));
    expect(offRecord.isOff(IDS.session)).toBe(false);
  });

  it('starts off the record when the session already is', async () => {
    const { offRecord, connect } = await setup({ offRecordInRow: true });
    await connect();
    await expect.poll(() => offRecord.isOff(IDS.session)).toBe(true);
  });
});

describe('chat commands', () => {
  it('/off and /on go to gateway as chat off-record requests and switch frames at once', async () => {
    const { gateway, offRecord, connect } = await setup();
    const ws = await connect();
    ws.send(JSON.stringify(chat(EXPERT, '/off')));
    await expect.poll(() => offRecord.isOff(IDS.session)).toBe(true);
    ws.send(JSON.stringify(chat(EXPERT, '  /ON please')));
    await expect.poll(() => offRecord.isOff(IDS.session)).toBe(false);
    expect(gateway.offRecords).toEqual([
      [IDS.session, true],
      [IDS.session, false],
    ]);
  });

  it('ignores other messages, the bot’s own, and keeps state when gateway fails', async () => {
    const { gateway, offRecord, connect } = await setup();
    const ws = await connect();
    ws.send(JSON.stringify(chat(EXPERT, 'can we go /off later?')));
    ws.send(JSON.stringify(chat(EXPERT, '/offline')));
    ws.send(JSON.stringify(chat({ id: 300, name: 'Sidekik (recording)' }, '/off')));
    gateway.fail = new HttpError(504, 'gateway_timeout', 'timed out');
    ws.send(JSON.stringify(chat(EXPERT, '/off')));
    await new Promise((r) => setTimeout(r, 100));
    expect(gateway.offRecords).toEqual([]);
    expect(offRecord.isOff(IDS.session)).toBe(false);
  });
});
