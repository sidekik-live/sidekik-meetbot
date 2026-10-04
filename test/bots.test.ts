import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { HttpError } from '../src/errors.js';
import { platformOf } from '../src/services/bots.js';
import { IDS, SECRETS, buildTestApp, fakeGateway, fakeRecall, seededStore } from './helpers.js';

const MEET = 'https://meet.google.com/abc-defg-hij';
const auth = { 'x-internal-token': SECRETS.internal };

let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function setup() {
  const store = seededStore();
  const recall = fakeRecall();
  const gateway = fakeGateway();
  app = await buildTestApp({ store, recall, gateway });
  const create = (body: unknown, headers: Record<string, string> = auth) =>
    app!.inject({ method: 'POST', url: '/internal/bots', headers, payload: body as object });
  const remove = (sid: string, headers: Record<string, string> = auth) =>
    app!.inject({ method: 'DELETE', url: `/internal/bots/${sid}`, headers });
  return { store, recall, gateway, create, remove };
}

describe('POST /internal/bots', () => {
  it('sends a bot that runs the agent-host page and streams to our real-time socket', async () => {
    const { store, recall, gateway, create } = await setup();
    const res = await create({ session_id: IDS.session, meeting_url: MEET });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ bot_id: 'bot-1' });

    expect(gateway.tokens).toEqual([`${IDS.session}:t1`]);
    expect(recall.created).toEqual([
      {
        sessionId: IDS.session,
        meetingUrl: MEET,
        botName: 'Sidekik (recording)',
        agentHostUrl: `https://app.sidekik.live/agent-host/${IDS.session}?t=t1`,
        realtimeUrl: `wss://bot.sidekik.live/recall/ws/${IDS.session}/?secret=${SECRETS.ws}`,
      },
    ]);
    expect(store.data.bots).toEqual([
      {
        org_id: IDS.org,
        session_id: IDS.session,
        bot_id: 'bot-1',
        platform: 'google_meet',
        status: 'created',
        joined_at: null,
        left_at: null,
        error: null,
      },
    ]);
  });

  it('returns the live bot instead of sending a second one, even for concurrent retries', async () => {
    const { recall, create } = await setup();
    const [a, b] = await Promise.all([
      create({ session_id: IDS.session, meeting_url: MEET }),
      create({ session_id: IDS.session, meeting_url: MEET }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(a.json()).toEqual(b.json());
    const again = await create({ session_id: IDS.session, meeting_url: MEET });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ bot_id: 'bot-1' });
    expect(recall.created).toHaveLength(1);
  });

  it('uses the bot name the gateway sends', async () => {
    const { recall, create } = await setup();
    await create({ session_id: IDS.session, meeting_url: MEET, bot_name: 'Sidekik (test)' });
    expect(recall.created[0]?.botName).toBe('Sidekik (test)');
  });

  it('refuses unknown, ended and browser-mode sessions', async () => {
    const { recall, create } = await setup();
    expect((await create({ session_id: 'missing', meeting_url: MEET })).statusCode).toBe(404);
    expect((await create({ session_id: IDS.ended, meeting_url: MEET })).json()).toMatchObject({ error: 'session_ended' });
    expect((await create({ session_id: IDS.browser, meeting_url: MEET })).json()).toMatchObject({ error: 'not_meeting_session' });
    expect(recall.created).toHaveLength(0);
  });

  it('checks the internal token and the body', async () => {
    const { create } = await setup();
    expect((await create({ session_id: IDS.session, meeting_url: MEET }, {})).statusCode).toBe(401);
    expect((await create({ session_id: IDS.session, meeting_url: MEET }, { 'x-internal-token': 'nope' })).statusCode).toBe(401);
    expect((await create({ session_id: IDS.session, meeting_url: 'not a url' })).statusCode).toBe(400);
  });

  it('passes Recall and gateway failures through and records no bot', async () => {
    const { store, recall, gateway, create } = await setup();
    recall.fail = new HttpError(502, 'recall_error', 'Recall bot/ returned 400');
    expect((await create({ session_id: IDS.session, meeting_url: MEET })).statusCode).toBe(502);
    recall.fail = undefined;
    gateway.fail = new HttpError(504, 'gateway_timeout', 'gateway timed out');
    expect((await create({ session_id: IDS.session, meeting_url: MEET })).statusCode).toBe(504);
    expect(store.data.bots).toEqual([]);
  });
});

describe('DELETE /internal/bots/:sid', () => {
  it('asks Recall to take the live bot out of the call', async () => {
    const { store, recall, create, remove } = await setup();
    await create({ session_id: IDS.session, meeting_url: MEET });
    const res = await remove(IDS.session);
    expect(res.statusCode).toBe(204);
    expect(recall.left).toEqual(['bot-1']);
    expect(store.data.bots[0]).toMatchObject({ status: 'leave_requested', left_at: null });
  });

  it('is a no-op without a live bot', async () => {
    const { recall, remove } = await setup();
    expect((await remove(IDS.session)).statusCode).toBe(204);
    expect((await remove('missing')).statusCode).toBe(204);
    expect(recall.left).toEqual([]);
  });

  it('needs the internal token', async () => {
    const { remove } = await setup();
    expect((await remove(IDS.session, {})).statusCode).toBe(401);
  });
});

describe('platformOf', () => {
  it('names the platform from the meeting URL', () => {
    expect(platformOf(MEET)).toBe('google_meet');
    expect(platformOf('https://us02web.zoom.us/j/123')).toBe('zoom');
    expect(platformOf('https://teams.microsoft.com/l/meetup-join/x')).toBe('teams');
    expect(platformOf('https://teams.live.com/meet/1')).toBe('teams');
    expect(platformOf('https://example.webex.com/meet/x')).toBe('unknown');
  });
});
