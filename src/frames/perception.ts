import type { FastifyBaseLogger } from 'fastify';
import WebSocket from 'ws';
import { INTERNAL_TOKEN_HEADER, type FrameHeader } from '../contracts/index.js';

/** Perception closes the frames socket with this code once the session has ended. */
export const SESSION_GONE = 4410;

/** The frames wire format: big-endian uint32 header length, the JSON header, the JPEG bytes. */
export function encodeFrame(header: FrameHeader, jpeg: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(json.length, 0);
  return Buffer.concat([len, json, jpeg]);
}

export type PerceptionLinkOptions = {
  /** ws(s)://perception — the link connects to {baseUrl}/internal/frames/{sid}. */
  baseUrl: string;
  sessionId: string;
  internalToken: string;
  log: FastifyBaseLogger;
  /** Unsent bytes above which a frame is dropped rather than queued. */
  maxBufferedBytes?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
};

/**
 * Meetbot → perception `WS /internal/frames/:sid` with `X-Internal-Token` (DESIGN §2). Reconnects
 * with backoff; frames that arrive while it's down, or while the socket is still sending the
 * previous one, are dropped (a newer one follows within a second). Stops for good when perception
 * says the session has ended.
 */
export class PerceptionLink {
  private ws: WebSocket | undefined;
  private backoff: number;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  readonly stats = { sent: 0, dropped_down: 0, dropped_busy: 0, connects: 0 };

  constructor(private readonly opts: PerceptionLinkOptions) {
    this.backoff = opts.minBackoffMs ?? 500;
    this.connect();
  }

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(jpeg: Buffer, tMs: number): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.stats.dropped_down++;
      return false;
    }
    if (ws.bufferedAmount > (this.opts.maxBufferedBytes ?? 512 * 1024)) {
      this.stats.dropped_busy++;
      return false;
    }
    ws.send(encodeFrame({ t_ms: tMs, reason: 'tick' }, jpeg), { binary: true });
    this.stats.sent++;
    return true;
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.ws?.close(1000, 'meetbot done');
    this.ws = undefined;
  }

  private connect(): void {
    if (this.closed) return;
    const url = new URL(`internal/frames/${encodeURIComponent(this.opts.sessionId)}`, withSlash(this.opts.baseUrl));
    const ws = new WebSocket(url, { headers: { [INTERNAL_TOKEN_HEADER]: this.opts.internalToken } });
    this.ws = ws;
    ws.on('open', () => {
      this.stats.connects++;
      this.backoff = this.opts.minBackoffMs ?? 500;
      this.opts.log.info('perception frames: connected');
    });
    ws.on('error', (err) => this.opts.log.warn({ err: err.message }, 'perception frames: socket error'));
    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      if (code === SESSION_GONE) {
        this.closed = true;
        this.opts.log.info('perception frames: session ended');
        return;
      }
      if (this.closed) return;
      const delay = this.backoff;
      this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs ?? 5000);
      this.timer = setTimeout(() => this.connect(), delay);
      this.timer.unref();
    });
  }
}

const withSlash = (base: string) => (base.endsWith('/') ? base : `${base}/`);
