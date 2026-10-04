import { describe, expect, it } from 'vitest';
import { RAW_ENV, testEnv } from './helpers.js';
import { loadEnv } from '../src/env.js';

describe('env', () => {
  it('parses a complete environment with defaults', () => {
    const { PORT: _port, APP_URL: _app, LOG_LEVEL: _level, ...rest } = RAW_ENV;
    const env = loadEnv(rest);
    expect(env.PORT).toBe(8086);
    expect(env.APP_URL).toBe('https://app.sidekik.live');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.RECALL_REGION).toBe('us-west-2');
  });

  it('lists every bad variable at once', () => {
    expect(() => testEnv({ RECALL_REGION: 'mars-1', SK_INTERNAL_TOKEN: 'short', PUBLIC_URL: 'nope' })).toThrow(
      /RECALL_REGION[\s\S]*SK_INTERNAL_TOKEN|SK_INTERNAL_TOKEN[\s\S]*RECALL_REGION/,
    );
    expect(() => loadEnv({ ...RAW_ENV, RECALL_API_KEY: undefined })).toThrow(/RECALL_API_KEY/);
  });
});
