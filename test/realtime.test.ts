import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { App } from '../src/app.js';
import { STREAMS } from '../src/contracts/index.js';
import { parseRealtimeMessage } from '../src/recall/realtime.js';
import { createRealtimeHub, type ScreenSink } from '../src/services/realtime.js';
import { IDS, SECRETS, STARTED_AT, buildTestApp, fakeBus, seededStore, sessionRow } from './helpers.js';

const EXPERT = { id: 100, name: 'Sabine', is_host: true };
const COLLEAGUE = { id: 200, name: 'Jonas', is_host: false };
const BOT = { id: 300, name: 'Sidekik (recording)', is_host: false };

/** Seconds after session start, as Recall's timestamp. */
const ts = (s: number) => ({ absolute: new Date(Date.parse(STARTED_AT) + s * 1000).toISOString(), relative: s });

const participantEvent = (event: string, participant: object, s: number) => ({
  event: `participant_events.${event}`,
  data: { data: { participant, timestamp: ts(s), data: null }, bot: { id: 'bot-1', metadata: {} } },
});
const video = (type: 'webcam' | 'screenshare', participant: object, bytes: number[], s: number) => ({
  event: 'video_separate_h264.data',
  data: {
    data: { buffer: Buffer.from(bytes).toString('base64'), timestamp: ts(s), type, participant },
    bot: { id: 'bot-1', metadata: {} },
  },
});
const chat = (participant: object, text: string, s: number) => ({
  event: 'participant_events.chat_message',
  data: { data: { participant, timestamp: ts(s), data: { text, to: 'everyone' } }, bot: { id: 'bot-1', metadata: {} } },
});

/** A sink that records what reaches it. */
function recordingSink() {
  const calls: (string | [number[], number])[] = [];
  const sink: ScreenSink = {
    frame: (h264, tMs) => void calls.push([[...h264], tMs]),
    stop: () => void calls.push('stop'),
    close: () => void calls.push('close'),
  };
  return { calls, sink };
}

const silentLog = { info() {}, warn() {}, error() {}, debug() {}, child: () => silentLog } as never;

function hubSetup() {
  const bus = fakeBus();
  const { calls, sink } = recordingSink();
  const chats: string[] = [];
  const hub = createRealtimeHub({
    bus,
    botName: 'Sidekik (recording)',
    screenSink: () => sink,
    onChat: (_live, msg) => void chats.push(msg.data.data.data?.text ?? ''),
    graceMs: 10,
  });
  const live = hub.open(sessionRow(), silentLog);
  const send = (m: object) => hub.handle(live, parseRealtimeMessage(JSON.stringify(m))!);
  return { bus, hub, live, calls, chats, send };
}

describe('realtime hub', () => {
  it('publishes speech from people, never from the bot', async () => {
    const { bus, send } = hubSetup();
    await send(participantEvent('speech_on', EXPERT, 12.5));
    await send(participantEvent('speech_on', BOT, 13));
    await send(participantEvent('speech_off', EXPERT, 15));
    expect(bus.events(STREAMS.speech).map((e) => [e.data, e.t_ms, e.producer])).toEqual([
      [{ kind: 'user_speech_start', source: 'recall' }, 12_500, 'meetbot'],
      [{ kind: 'user_speech_end', source: 'recall' }, 15_000, 'meetbot'],
    ]);
  });

  it('forwards only the sharer’s screen, and follows the share as it moves', async () => {
    const { live, calls, send } = hubSetup();
    await send(video('screenshare', EXPERT, [1], 1)); // socket opened after screenshare_on: adopted
    await send(video('webcam', EXPERT, [2], 1));
    await send(participantEvent('screenshare_on', COLLEAGUE, 2));
    await send(video('screenshare', EXPERT, [3], 2)); // no longer the sharer
    await send(video('screenshare', COLLEAGUE, [4], 3));
    await send(participantEvent('screenshare_off', COLLEAGUE, 4));
    await send(video('screenshare', COLLEAGUE, [5], 5)); // adopted again: Recall still sends it
    expect(calls).toEqual([[[1], 1000], 'stop', [[4], 3000], 'stop', [[5], 5000]]);
    expect(live.stats).toMatchObject({ frames: 3, ignored: 2 });
  });

  it('passes chat messages on, except the bot’s own', async () => {
    const { chats, send } = hubSetup();
    await send(chat(EXPERT, '/off', 1));
    await send(chat(BOT, 'Sidekik is recording…', 1));
    expect(chats).toEqual(['/off']);
  });

  it('keeps state across a reconnect and closes the sink when disposed', async () => {
    const { hub, live, calls, send } = hubSetup();
    await send(participantEvent('screenshare_on', EXPERT, 1));
    hub.release(IDS.session);
    expect(hub.open(sessionRow(), silentLog)).toBe(live);
    expect(live.sharer).toBe(EXPERT.id);
    await send(video('screenshare', EXPERT, [9], 2));
    hub.release(IDS.session);
    await new Promise((r) => setTimeout(r, 30));
    expect(hub.get(IDS.session)).toBeUndefined();
    expect(calls.at(-1)).toBe('close');
  });

  it('ignores messages it does not subscribe to', () => {
    expect(parseRealtimeMessage('{"event":"transcript.data","data":{}}')).toBeNull();
    expect(parseRealtimeMessage('not json')).toBeNull();
  });
});

describe('WS /recall/ws/:sid', () => {
  let app: App | undefined;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate();
    await app?.close();
    app = undefined;
  });

  async function serve() {
    const bus = fakeBus();
    const { calls, sink } = recordingSink();
    app = await buildTestApp({ store: seededStore(), bus, screenSink: () => sink });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const url = (sid: string, secret: string) => `ws://127.0.0.1:${port}/recall/ws/${sid}/?secret=${secret}`;
    return { bus, calls, url };
  }

  /** Resolves with the socket once open, or with the HTTP status of a refused upgrade. */
  const connect = (url: string) =>
    new Promise<WebSocket | number>((resolve) => {
      const ws = new WebSocket(url);
      sockets.push(ws);
      ws.on('error', () => {});
      ws.on('open', () => resolve(ws));
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    });

  it('takes Recall’s messages on the trailing-slash URL', async () => {
    const { bus, calls, url } = await serve();
    const ws = (await connect(url(IDS.session, SECRETS.ws))) as WebSocket;
    ws.send(JSON.stringify(participantEvent('speech_on', EXPERT, 1)));
    ws.send(JSON.stringify(video('screenshare', EXPERT, [7, 7], 2)));
    ws.send('garbage');
    await expect.poll(() => bus.events(STREAMS.speech).length).toBe(1);
    await expect.poll(() => calls).toEqual([[[7, 7], 2000]]);
  });

  it('refuses a wrong secret and sessions that are unknown, ended or not in meeting mode', async () => {
    const { url } = await serve();
    expect(await connect(url(IDS.session, 'wrong'))).toBe(401);
    expect(await connect(url('missing', SECRETS.ws))).toBe(404);
    expect(await connect(url(IDS.ended, SECRETS.ws))).toBe(404);
    expect(await connect(url(IDS.browser, SECRETS.ws))).toBe(404);
  });
});
