import { z } from 'zod';
import { BaseServiceEnvSchema, loadEnv as parseEnv } from './contracts/index.js';

// Shared secrets are generated with `openssl rand -hex 32` (64 hex chars).
const secret = z.string().min(32, 'must be at least 32 characters (openssl rand -hex 32)');
const url = z.url();

export const envSchema = BaseServiceEnvSchema.extend({
  PORT: z.coerce.number().int().positive().default(8086),
  SK_INTERNAL_TOKEN: secret,

  RECALL_API_KEY: z.string().min(1),
  // The Recall region the API key belongs to: the API host is https://{RECALL_REGION}.recall.ai.
  RECALL_REGION: z.enum(['us-east-1', 'us-west-2', 'eu-central-1', 'ap-northeast-1']),
  // Sent by Recall as ?secret= on the real-time WebSocket (we put it in the URL we give Recall).
  RECALL_WS_SECRET: secret,
  // Recall's workspace webhook verification secret (whsec_…), from the Recall dashboard.
  RECALL_WEBHOOK_SECRET: z.string().min(1),

  PERCEPTION_INTERNAL_URL: url,
  GATEWAY_INTERNAL_URL: url,
  // The agent-host page Recall runs as the bot's camera: {APP_URL}/agent-host/{sid}?t=…
  APP_URL: url.default('https://app.sidekik.live'),
  // This service's public base URL; Recall connects to wss://{host}/recall/ws/:sid.
  PUBLIC_URL: url,
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return parseEnv(envSchema, source);
}
