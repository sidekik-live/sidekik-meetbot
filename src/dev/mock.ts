// `pnpm dev:mock`: meetbot with no Recall account, no Supabase and no teammates' services. Recall is a
// stand-in that logs the bot it would create; Redis comes from sidekik-platform's docker-compose.
import { randomUUID } from 'node:crypto';
import { buildApp } from '../app.js';
import { loadEnv } from '../env.js';
import { createServiceLogger } from '../logger.js';
import { createBotBody, type RecallClient } from '../recall/client.js';
import { redisHealth } from '../redis-health.js';

const DEV_SECRET = 'dev-mock-secret-not-for-production-0000000000';
const env = loadEnv({
  REDIS_URL: 'redis://localhost:6379',
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'unused-in-mock',
  SK_INTERNAL_TOKEN: DEV_SECRET,
  RECALL_API_KEY: 'unused-in-mock',
  RECALL_REGION: 'us-west-2',
  RECALL_WS_SECRET: DEV_SECRET,
  RECALL_WEBHOOK_SECRET: `whsec_${Buffer.from(DEV_SECRET).toString('base64')}`,
  PERCEPTION_INTERNAL_URL: 'ws://localhost:8081',
  GATEWAY_INTERNAL_URL: 'http://localhost:8080',
  PUBLIC_URL: 'http://localhost:8086',
  LOG_LEVEL: 'info',
  ...process.env,
});
const log = createServiceLogger(env.LOG_LEVEL);
const redis = redisHealth(env.REDIS_URL, log);

const recall: RecallClient = {
  async createBot(input) {
    const id = randomUUID();
    log.info({ session_id: input.sessionId, bot_id: id, body: createBotBody(input) }, 'mock recall: bot created');
    return { id };
  },
  async leaveCall(botId) {
    log.info({ bot_id: botId }, 'mock recall: bot left the call');
  },
};

const app = await buildApp({ env, recall, healthChecks: { redis: redis.check }, loggerInstance: log });
app.addHook('onClose', redis.close);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}

await app.listen({ host: '::', port: env.PORT });
app.log.info({ internal_token: env.SK_INTERNAL_TOKEN }, 'mock meetbot ready');
