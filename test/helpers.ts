import { buildApp, type AppDeps } from '../src/app.js';
import { streamEnvelopeSchema, type Bus, type Envelope, type StreamKey } from '../src/contracts/index.js';
import { loadEnv, type Env } from '../src/env.js';
import type { RecallClient } from '../src/recall/client.js';
import type { GatewayClient } from '../src/services/gateway.js';
import { memoryStore } from '../src/store/memory.js';
import type { SessionRow } from '../src/store/types.js';

export const IDS = {
  org: '00000000-0000-4000-8000-00000000a001',
  workflow: '00000000-0000-4000-8000-00000000b001',
  session: '00000000-0000-4000-8000-00000000d001',
  browser: '00000000-0000-4000-8000-00000000d002',
  ended: '00000000-0000-4000-8000-00000000d003',
};

export const STARTED_AT = '2026-10-04T10:00:00.000Z';

export function sessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: IDS.session,
    org_id: IDS.org,
    workflow_id: IDS.workflow,
    kind: 'capture',
    mode: 'meeting',
    phase: 'capture',
    workmap_id: null,
    language: 'de',
    off_record: false,
    started_at: STARTED_AT,
    ended_at: null,
    ...overrides,
  };
}

export const seededStore = () =>
  memoryStore({
    sessions: [
      sessionRow(),
      sessionRow({ id: IDS.browser, mode: 'browser' }),
      sessionRow({ id: IDS.ended, ended_at: '2026-10-04T11:00:00.000Z' }),
    ],
  });

/** Hands out numbered one-time tokens; `fail` makes the next calls throw. */
export function fakeGateway() {
  let n = 0;
  const fake = {
    fail: undefined as Error | undefined,
    tokens: [] as string[],
    offRecords: [] as [string, boolean][],
    async offRecord(sessionId: string, on: boolean) {
      if (fake.fail) throw fake.fail;
      fake.offRecords.push([sessionId, on]);
    },
    async agentHostToken(sessionId: string) {
      if (fake.fail) throw fake.fail;
      const t = `t${++n}`;
      fake.tokens.push(`${sessionId}:${t}`);
      return t;
    },
  } satisfies GatewayClient & Record<string, unknown>;
  return fake;
}

export const SECRETS = {
  internal: 'i'.repeat(64),
  ws: 'w'.repeat(64),
  webhook: `whsec_${Buffer.from('webhook-signing-key-for-tests-0001').toString('base64')}`,
};

export const RAW_ENV: Record<string, string> = {
  PORT: '8086',
  LOG_LEVEL: 'silent',
  REDIS_URL: 'redis://localhost:6379',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  SK_INTERNAL_TOKEN: SECRETS.internal,
  RECALL_API_KEY: 'recall-key',
  RECALL_REGION: 'us-west-2',
  RECALL_WS_SECRET: SECRETS.ws,
  RECALL_WEBHOOK_SECRET: SECRETS.webhook,
  PERCEPTION_INTERNAL_URL: 'ws://localhost:8081',
  GATEWAY_INTERNAL_URL: 'http://localhost:8080',
  APP_URL: 'https://app.sidekik.live',
  PUBLIC_URL: 'https://bot.sidekik.live',
};

export const testEnv = (overrides: Record<string, string> = {}): Env => loadEnv({ ...RAW_ENV, ...overrides });

/** Records every call; `fail` makes the next calls throw. */
export function fakeRecall() {
  const created: Parameters<RecallClient['createBot']>[0][] = [];
  const left: string[] = [];
  let n = 0;
  const fake = {
    created,
    left,
    fail: undefined as Error | undefined,
    async createBot(input: Parameters<RecallClient['createBot']>[0]) {
      if (fake.fail) throw fake.fail;
      created.push(input);
      return { id: `bot-${++n}` };
    },
    async leaveCall(botId: string) {
      if (fake.fail) throw fake.fail;
      left.push(botId);
    },
    async statusChanges() {
      return [];
    },
  };
  return fake;
}

type Handler = (ev: Envelope<unknown>) => Promise<void>;

/** Records published events (validated like the real bus); `deliver` feeds a consumer. */
export function fakeBus() {
  const published: { stream: StreamKey; ev: Envelope<unknown> }[] = [];
  const handlers = new Map<StreamKey, Handler>();
  const bus: Bus & {
    published: typeof published;
    fail?: Error;
    deliver(stream: StreamKey, ev: Envelope<unknown>): Promise<void>;
    events(stream: StreamKey): Envelope<unknown>[];
  } = {
    published,
    async publish(stream, ev) {
      if (bus.fail) throw bus.fail;
      streamEnvelopeSchema(stream).parse(ev);
      published.push({ stream, ev });
      return `${published.length}-0`;
    },
    consume(stream, handler) {
      handlers.set(stream, handler as Handler);
      return () => handlers.delete(stream);
    },
    async deliver(stream, ev) {
      const handler = handlers.get(stream);
      if (!handler) throw new Error(`no consumer for ${stream}`);
      await handler(ev);
    },
    events: (stream) => published.filter((p) => p.stream === stream).map((p) => p.ev),
    async close() {},
  };
  return bus;
}

export function buildTestApp(overrides: Partial<AppDeps> = {}) {
  return buildApp({
    env: testEnv(),
    recall: fakeRecall(),
    gateway: fakeGateway(),
    store: seededStore(),
    bus: fakeBus(),
    healthChecks: {},
    logger: false,
    ...overrides,
  });
}
