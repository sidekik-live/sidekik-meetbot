import { buildApp, type AppDeps } from '../src/app.js';
import { loadEnv, type Env } from '../src/env.js';
import type { RecallClient } from '../src/recall/client.js';

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
  };
  return fake;
}

export function buildTestApp(overrides: Partial<AppDeps> = {}) {
  return buildApp({
    env: testEnv(),
    recall: fakeRecall(),
    healthChecks: {},
    logger: false,
    ...overrides,
  });
}
