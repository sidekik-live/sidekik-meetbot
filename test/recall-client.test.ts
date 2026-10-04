import { describe, expect, it } from 'vitest';
import {
  BOT_NAME,
  agentHostUrl,
  createBotBody,
  httpRecallClient,
  realtimeUrl,
} from '../src/recall/client.js';

const SID = '00000000-0000-4000-8000-00000000d001';

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };

/** A fetch that records each request and answers with `reply`. */
function fakeFetch(reply: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(init?.body !== undefined && { body: JSON.parse(String(init.body)) }),
    };
    calls.push(call);
    return reply(call);
  }) as typeof fetch;
  return { calls, impl };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Recall URLs', () => {
  it('puts the slash Recall requires before the real-time query string', () => {
    expect(realtimeUrl('https://bot.sidekik.live', SID, 'abc')).toBe(`wss://bot.sidekik.live/recall/ws/${SID}/?secret=abc`);
    expect(realtimeUrl('http://localhost:8086/', SID, 'a b')).toBe(`ws://localhost:8086/recall/ws/${SID}/?secret=a+b`);
  });

  it('builds the agent-host URL with its one-time token', () => {
    expect(agentHostUrl('https://app.sidekik.live', SID, 't0k/=')).toBe(`https://app.sidekik.live/agent-host/${SID}?t=t0k%2F%3D`);
  });
});

describe('createBotBody', () => {
  it('asks for the agent-host camera, per-participant H.264 and the real-time events', () => {
    const body = createBotBody({
      sessionId: SID,
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
      botName: BOT_NAME,
      agentHostUrl: 'https://app.sidekik.live/agent-host/x?t=1',
      realtimeUrl: 'wss://bot.sidekik.live/recall/ws/x/?secret=s',
    });
    expect(body).toMatchObject({
      meeting_url: 'https://meet.google.com/abc-defg-hij',
      bot_name: 'Sidekik (recording)',
      metadata: { session_id: SID },
      variant: { google_meet: 'web_4_core' },
      output_media: { camera: { kind: 'webpage', config: { url: 'https://app.sidekik.live/agent-host/x?t=1' } } },
      recording_config: {
        video_mixed_layout: 'gallery_view_v2',
        video_separate_h264: {},
        retention: null,
        realtime_endpoints: [{ type: 'websocket', url: 'wss://bot.sidekik.live/recall/ws/x/?secret=s' }],
      },
      chat: { on_bot_join: { send_to: 'everyone' } },
    });
    expect(body.recording_config.realtime_endpoints[0]!.events).toEqual([
      'video_separate_h264.data',
      'participant_events.speech_on',
      'participant_events.speech_off',
      'participant_events.screenshare_on',
      'participant_events.screenshare_off',
      'participant_events.chat_message',
    ]);
  });
});

describe('httpRecallClient', () => {
  const input = {
    sessionId: SID,
    meetingUrl: 'https://meet.google.com/abc-defg-hij',
    botName: BOT_NAME,
    agentHostUrl: 'https://app.sidekik.live/agent-host/x?t=1',
    realtimeUrl: 'wss://bot.sidekik.live/recall/ws/x/?secret=s',
  };

  it('creates a bot in the configured region with the API key', async () => {
    const { calls, impl } = fakeFetch(() => json(201, { id: 'bot-123', meeting_url: {} }));
    const recall = httpRecallClient({ apiKey: 'key', region: 'eu-central-1', fetchImpl: impl });
    expect(await recall.createBot(input)).toEqual({ id: 'bot-123' });
    expect(calls).toEqual([
      {
        url: 'https://eu-central-1.recall.ai/api/v1/bot/',
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Token key', 'content-type': 'application/json' }),
        body: createBotBody(input),
      },
    ]);
  });

  it('removes a bot from its call', async () => {
    const { calls, impl } = fakeFetch(() => json(200, { id: 'bot-123' }));
    await httpRecallClient({ apiKey: 'key', region: 'us-west-2', fetchImpl: impl }).leaveCall('bot-123');
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['POST', 'https://us-west-2.recall.ai/api/v1/bot/bot-123/leave_call/', undefined],
    ]);
  });

  it('surfaces Recall errors, bad answers and timeouts as 5xx', async () => {
    const rejecting = httpRecallClient({
      apiKey: 'key',
      region: 'us-west-2',
      fetchImpl: fakeFetch(() => json(400, { meeting_url: ['Invalid meeting URL'] })).impl,
    });
    await expect(rejecting.createBot(input)).rejects.toMatchObject({
      statusCode: 502,
      code: 'recall_error',
      message: expect.stringContaining('Invalid meeting URL'),
    });

    const noId = httpRecallClient({ apiKey: 'key', region: 'us-west-2', fetchImpl: fakeFetch(() => json(201, {})).impl });
    await expect(noId.createBot(input)).rejects.toMatchObject({ statusCode: 502, code: 'recall_bad_response' });

    const hanging = (async (_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)),
      )) as typeof fetch;
    const slow = httpRecallClient({ apiKey: 'key', region: 'us-west-2', timeoutMs: 20, fetchImpl: hanging });
    await expect(slow.leaveCall('bot-1')).rejects.toMatchObject({ statusCode: 504, code: 'recall_timeout' });
  });
});
