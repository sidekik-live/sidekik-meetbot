import { buildApp } from './app.js';
import { createBus } from './contracts/index.js';
import { loadEnv } from './env.js';
import { createServiceLogger } from './logger.js';
import { httpRecallClient } from './recall/client.js';
import { redisHealth } from './redis-health.js';
import { httpGatewayClient } from './services/gateway.js';
import { supabaseStore } from './store/supabase.js';
import { createSupabase, supabaseHealth } from './supabase.js';

const env = loadEnv();
const supabase = createSupabase(env);
const log = createServiceLogger(env.LOG_LEVEL);
const bus = createBus(env.REDIS_URL, 'meetbot', { logger: log.child({ component: 'bus' }) });
const redis = redisHealth(env.REDIS_URL, log);

const app = await buildApp({
  env,
  recall: httpRecallClient({ apiKey: env.RECALL_API_KEY, region: env.RECALL_REGION }),
  gateway: httpGatewayClient(env.GATEWAY_INTERNAL_URL, env.SK_INTERNAL_TOKEN),
  store: supabaseStore(supabase),
  bus,
  healthChecks: {
    supabase: supabaseHealth(supabase),
    redis: redis.check,
  },
  loggerInstance: log,
});
app.addHook('onClose', () => bus.close());
app.addHook('onClose', redis.close);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  });
}

try {
  // Railway's private network is IPv6; `::` also accepts IPv4.
  await app.listen({ host: '::', port: env.PORT });
} catch (err) {
  app.log.fatal({ err }, 'failed to start');
  process.exit(1);
}
