import { buildApp } from './app.js';
import { loadEnv } from './env.js';
import { createServiceLogger } from './logger.js';
import { httpRecallClient } from './recall/client.js';
import { redisHealth } from './redis-health.js';
import { createSupabase, supabaseHealth } from './supabase.js';

const env = loadEnv();
const supabase = createSupabase(env);
const log = createServiceLogger(env.LOG_LEVEL);
const redis = redisHealth(env.REDIS_URL, log);

const app = await buildApp({
  env,
  recall: httpRecallClient({ apiKey: env.RECALL_API_KEY, region: env.RECALL_REGION }),
  healthChecks: {
    supabase: supabaseHealth(supabase),
    redis: redis.check,
  },
  loggerInstance: log,
});
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
