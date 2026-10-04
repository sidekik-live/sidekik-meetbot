import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/** Svix-style signatures older than this are rejected (replay protection). */
const TOLERANCE_SEC = 5 * 60;

type Headers = Record<string, string | string[] | undefined>;
const header = (headers: Headers, name: string) => {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * Verifies a request signed with Recall's workspace verification secret (docs.recall.ai:
 * authenticating requests from Recall). Status webhooks come through Svix, so the headers are
 * `webhook-*` or, on older workspaces, `svix-*`:
 * - the key is the secret without `whsec_`, base64-decoded;
 * - the signed content is `${id}.${timestamp}.${rawBody}`;
 * - the signature header holds space-separated `v1,<base64 HMAC-SHA256>` entries (several while
 *   the secret rotates); any match passes.
 */
export function verifyRecallSignature(
  headers: Headers,
  rawBody: string,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
): { ok: true; id: string } | { ok: false; reason: string } {
  const id = header(headers, 'webhook-id') ?? header(headers, 'svix-id');
  const timestamp = header(headers, 'webhook-timestamp') ?? header(headers, 'svix-timestamp');
  const signatures = header(headers, 'webhook-signature') ?? header(headers, 'svix-signature');
  if (!id || !timestamp || !signatures) return { ok: false, reason: 'missing signature headers' };

  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(nowSec - ts) > TOLERANCE_SEC) return { ok: false, reason: 'stale timestamp' };

  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret, 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest();
  for (const entry of signatures.split(' ')) {
    const [version, sig] = entry.split(',', 2);
    if (version !== 'v1' || !sig) continue;
    const given = Buffer.from(sig, 'base64');
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true, id };
  }
  return { ok: false, reason: 'bad signature' };
}

/** Signs a body the way Recall does; used by tests and `dev:mock` tooling. */
export function signRecallBody(rawBody: string, secret: string, id: string, timestamp: number): Record<string, string> {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const sig = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64');
  return { 'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': `v1,${sig}` };
}

/**
 * A bot status change webhook (`bot.joining_call`, `bot.in_call_recording`, `bot.call_ended`,
 * `bot.done`, `bot.fatal`, …). Recall says not to treat `code`/`sub_code` as enums.
 */
export const StatusWebhookSchema = z.object({
  event: z.string().min(1),
  data: z.object({
    data: z.object({
      code: z.string().min(1),
      sub_code: z.string().nullish(),
      updated_at: z.string().min(1),
    }),
    bot: z.object({
      id: z.string().min(1),
      metadata: z.record(z.string(), z.unknown()).nullish(),
    }),
  }),
});
export type StatusWebhook = z.infer<typeof StatusWebhookSchema>;
