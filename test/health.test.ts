import { describe, expect, it } from 'vitest';
import { buildTestApp } from './helpers.js';

describe('GET /healthz', () => {
  it('reports the version and every dependency', async () => {
    const app = await buildTestApp({
      healthChecks: { redis: async () => {}, supabase: async () => {} },
    });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, version: '0.1.0', deps: { redis: true, supabase: true } });
    await app.close();
  });

  it('answers 503 when a dependency is down', async () => {
    const app = await buildTestApp({
      healthChecks: {
        redis: async () => {},
        supabase: async () => {
          throw new Error('down');
        },
      },
    });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false, deps: { redis: true, supabase: false } });
    await app.close();
  });

  it('answers unknown routes with a JSON 404', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
    await app.close();
  });
});
