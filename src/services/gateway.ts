import { z } from 'zod';
import { AgentHostTokenResponseSchema, INTERNAL_TOKEN_HEADER } from '../contracts/index.js';
import { HttpError } from '../errors.js';

// Budgets from ARCHITECTURE §4.3.
export const BUDGET_MS = { agentHostToken: 200, offRecord: 500 } as const;

export interface GatewayClient {
  /** A one-time token for the agent-host page the bot runs as its camera. */
  agentHostToken(sessionId: string): Promise<string>;
  /** Sets the session off (`true`) or back on the record, from a meeting chat command. */
  offRecord(sessionId: string, on: boolean): Promise<void>;
}

export function httpGatewayClient(baseUrl: string, internalToken: string): GatewayClient {
  async function post<S extends z.ZodType>(path: string, body: unknown, schema: S, timeoutMs: number): Promise<z.infer<S>> {
    let res: Response;
    try {
      res = await fetch(new URL(path, baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', [INTERNAL_TOKEN_HEADER]: internalToken },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        throw new HttpError(504, 'gateway_timeout', `gateway ${path} timed out after ${timeoutMs} ms`);
      }
      throw new HttpError(502, 'gateway_unreachable', `gateway ${path} unreachable`);
    }
    if (!res.ok) throw new HttpError(502, 'gateway_error', `gateway ${path} returned ${res.status}`);
    const parsed = schema.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success) throw new HttpError(502, 'gateway_bad_response', `gateway ${path} returned an unexpected body`);
    return parsed.data;
  }

  return {
    async agentHostToken(sessionId) {
      const { t } = await post(
        '/internal/agent-host-token',
        { sid: sessionId },
        AgentHostTokenResponseSchema,
        BUDGET_MS.agentHostToken,
      );
      return t;
    },
    async offRecord(sessionId, on) {
      await post(
        `/internal/sessions/${encodeURIComponent(sessionId)}/off-record`,
        { on, source: 'chat' },
        z.record(z.string(), z.unknown()),
        BUDGET_MS.offRecord,
      );
    },
  };
}
