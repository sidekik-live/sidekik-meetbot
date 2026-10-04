import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { httpGatewayClient } from '../src/services/gateway.js';

const TOKEN = 'i'.repeat(64);
type Seen = { method: string; url: string; token?: string; body?: unknown };

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

/** A stand-in gateway that records each request and answers with `reply`. */
async function gateway(reply: (s: Seen) => [number, unknown] | null) {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c)).on('end', () => {
      const s: Seen = {
        method: req.method!,
        url: req.url!,
        token: req.headers['x-internal-token'] as string | undefined,
        ...(raw && { body: JSON.parse(raw) }),
      };
      seen.push(s);
      const answer = reply(s);
      if (!answer) return; // hang
      res.writeHead(answer[0], { 'content-type': 'application/json' }).end(JSON.stringify(answer[1]));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return { seen, url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}` };
}

describe('httpGatewayClient.agentHostToken', () => {
  it('asks for a one-time token with the internal token', async () => {
    const { seen, url } = await gateway(() => [200, { t: 'one-time', expires_at: '2026-10-04T10:05:00Z' }]);
    expect(await httpGatewayClient(url, TOKEN).agentHostToken('sid-1')).toBe('one-time');
    expect(seen).toEqual([{ method: 'POST', url: '/internal/agent-host-token', token: TOKEN, body: { sid: 'sid-1' } }]);
  });

  it('maps errors, bad bodies and the 200 ms budget to 5xx', async () => {
    const failing = await gateway(() => [409, { error: 'session_ended' }]);
    await expect(httpGatewayClient(failing.url, TOKEN).agentHostToken('s')).rejects.toMatchObject({ statusCode: 502 });
    await new Promise<void>((resolve) => server!.close(() => resolve()));

    const bad = await gateway(() => [200, { nope: true }]);
    await expect(httpGatewayClient(bad.url, TOKEN).agentHostToken('s')).rejects.toMatchObject({ code: 'gateway_bad_response' });
    await new Promise<void>((resolve) => server!.close(() => resolve()));

    const hanging = await gateway(() => null);
    const started = Date.now();
    await expect(httpGatewayClient(hanging.url, TOKEN).agentHostToken('s')).rejects.toMatchObject({ statusCode: 504 });
    expect(Date.now() - started).toBeLessThan(500);
    server!.closeAllConnections();
  });
});
