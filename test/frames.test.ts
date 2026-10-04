import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { H264Decoder, type SpawnFfmpeg } from '../src/frames/decoder.js';
import { JpegSplitter, nalTypes, startsDecoding } from '../src/frames/h264.js';
import { PerceptionLink, SESSION_GONE, encodeFrame } from '../src/frames/perception.js';
import { screenPipeline } from '../src/frames/pipeline.js';
import { sessionRow } from './helpers.js';

const silentLog = { info() {}, warn() {}, error() {}, debug() {}, child: () => silentLog } as never;
const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** 4 s of 640x360 testsrc at 10 fps, keyframe every second, one slice per frame (Annex-B). */
const FIXTURE = readFileSync(new URL('./fixtures/screen-640x360-10fps.h264', import.meta.url));

/** Splits Annex-B into access units: parameter sets/SEI ride with the next slice. */
function accessUnits(stream: Buffer): Buffer[] {
  const starts: number[] = [];
  for (let i = 0; i + 2 < stream.length; i++) {
    if (stream[i] === 0 && stream[i + 1] === 0 && stream[i + 2] === 1) {
      starts.push(i > 0 && stream[i - 1] === 0 ? i - 1 : i);
      i += 2;
    }
  }
  const units: Buffer[] = [];
  let auStart = starts[0] ?? 0;
  starts.forEach((start, n) => {
    const end = starts[n + 1] ?? stream.length;
    const type = nalTypes(stream.subarray(start, Math.min(end, start + 5)))[0];
    if (type === 1 || type === 5) {
      units.push(stream.subarray(auStart, end));
      auStart = end;
    }
  });
  return units;
}

const AUS = accessUnits(FIXTURE);

describe('H.264 helpers', () => {
  it('finds keyframes in the fixture', () => {
    expect(AUS).toHaveLength(40);
    expect(nalTypes(AUS[0]!)).toEqual(expect.arrayContaining([7, 8, 5]));
    expect(startsDecoding(AUS[0]!)).toBe(true);
    expect(startsDecoding(AUS[1]!)).toBe(false);
    expect(AUS.filter(startsDecoding)).toHaveLength(4);
  });

  it('splits concatenated JPEGs across chunk boundaries', () => {
    const a = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0x00, 3, 0xff, 0xd9]);
    const b = Buffer.from([0xff, 0xd8, 9, 0xff, 0xd9]);
    const all = Buffer.concat([Buffer.from([7]), a, b]);
    const splitter = new JpegSplitter();
    const out = [...splitter.push(all.subarray(0, 5)), ...splitter.push(all.subarray(5, 12)), ...splitter.push(all.subarray(12))];
    expect(out).toEqual([a, b]);
  });
});

/** A stand-in ffmpeg: records stdin, lets the test emit stdout and exit. */
function fakeFfmpeg() {
  const procs: { args: string[]; stdin: PassThrough; written: Buffer[]; emit: EventEmitter['emit']; stdout: PassThrough; killed: boolean }[] = [];
  const spawnImpl: SpawnFfmpeg = (_path, args) => {
    const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const written: Buffer[] = [];
    stdin.on('data', (c: Buffer) => written.push(c));
    const rec = { args, stdin, written, emit: proc.emit.bind(proc), stdout, killed: false };
    Object.assign(proc, { stdin, stdout, stderr: new PassThrough(), kill: () => ((rec.killed = true), true) });
    procs.push(rec);
    return proc as never;
  };
  return { procs, spawnImpl };
}

describe('H264Decoder', () => {
  it('waits for a keyframe, starts ffmpeg once, and restarts at the next keyframe after a reset', () => {
    const { procs, spawnImpl } = fakeFfmpeg();
    const decoder = new H264Decoder({ ffmpegPath: 'ffmpeg', log: silentLog, onJpeg: () => {}, spawnImpl });
    decoder.write(AUS[1]!);
    expect(procs).toHaveLength(0);
    for (const au of AUS.slice(0, 12)) decoder.write(au);
    expect(procs).toHaveLength(1);
    expect(procs[0]!.args).toEqual(expect.arrayContaining(['-use_wallclock_as_timestamps', '1', '-f', 'h264', 'fps=1,scale=\'min(1280,iw)\':-2']));
    expect(decoder.stats).toMatchObject({ written: 12, dropped_unsynced: 1 });

    decoder.reset();
    expect(procs[0]!.killed).toBe(true);
    decoder.write(AUS[12]!); // not a keyframe: dropped
    decoder.write(AUS[20]!); // keyframe: new ffmpeg
    expect(procs).toHaveLength(2);
    expect(decoder.stats.dropped_unsynced).toBe(2);
  });

  it('drops units while ffmpeg is behind, then resumes at a keyframe', () => {
    const { procs, spawnImpl } = fakeFfmpeg();
    const decoder = new H264Decoder({ ffmpegPath: 'ffmpeg', log: silentLog, onJpeg: () => {}, spawnImpl, maxBacklogBytes: 0 });
    decoder.write(AUS[0]!);
    procs[0]!.stdin.cork(); // ffmpeg stops reading
    decoder.write(AUS[1]!);
    decoder.write(AUS[2]!);
    procs[0]!.stdin.uncork();
    expect(decoder.stats).toMatchObject({ written: 2, dropped_backlog: 1, dropped_unsynced: 0 });
    decoder.write(AUS[3]!); // waits for the next keyframe
    expect(decoder.stats.dropped_unsynced).toBe(1);
  });

  it('passes JPEGs through and starts a new ffmpeg after one exits', () => {
    const { procs, spawnImpl } = fakeFfmpeg();
    const jpegs: number[][] = [];
    const decoder = new H264Decoder({ ffmpegPath: 'ffmpeg', log: silentLog, onJpeg: (j) => void jpegs.push([...j]), spawnImpl });
    decoder.write(AUS[0]!);
    procs[0]!.stdout.write(Buffer.from([0xff, 0xd8, 5, 0xff, 0xd9]));
    expect(jpegs).toEqual([[0xff, 0xd8, 5, 0xff, 0xd9]]);
    procs[0]!.emit('exit', 1, null);
    decoder.write(AUS[1]!);
    expect(procs).toHaveLength(1);
    decoder.write(AUS[10]!);
    expect(procs).toHaveLength(2);
  });

  it.skipIf(!hasFfmpeg)('decodes real H.264 to about one JPEG per second', async () => {
    const jpegs: Buffer[] = [];
    const decoder = new H264Decoder({ ffmpegPath: 'ffmpeg', log: silentLog, onJpeg: (j) => void jpegs.push(j) });
    for (const au of AUS) {
      decoder.write(au);
      await new Promise((r) => setTimeout(r, 100)); // the stream's own pace: 10 fps
    }
    // ~2.5 s to the first JPEG, then one per second.
    await expect.poll(() => jpegs.length, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
    decoder.close();
    expect(jpegs.length).toBeLessThanOrEqual(4);
    for (const j of jpegs) {
      expect([...j.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
      expect([...j.subarray(-2)]).toEqual([0xff, 0xd9]);
    }
  }, 20_000);
});

describe('PerceptionLink', () => {
  let wss: WebSocketServer | undefined;
  afterEach(async () => {
    if (wss) await new Promise<void>((resolve) => wss!.close(() => resolve()));
    wss = undefined;
  });

  /** A stand-in perception: records the upgrade path, token and each binary message. */
  async function perception(onConnection?: (socket: WebSocket) => void) {
    const seen: { url: string; token: string | undefined }[] = [];
    const frames: Buffer[] = [];
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    wss.on('connection', (socket, req) => {
      seen.push({ url: req.url!, token: req.headers['x-internal-token'] as string | undefined });
      socket.on('message', (data: Buffer) => frames.push(data));
      onConnection?.(socket);
    });
    await new Promise((r) => wss!.once('listening', r));
    return { seen, frames, url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}` };
  }

  it('sends frames in the wire format with the internal token, and drops them while down', async () => {
    const { seen, frames, url } = await perception();
    const link = new PerceptionLink({ baseUrl: url, sessionId: 'sid-1', internalToken: 'tok', log: silentLog });
    expect(link.send(Buffer.from([0xff, 0xd8, 0xff]), 1)).toBe(false); // not open yet
    await expect.poll(() => link.open).toBe(true);
    expect(link.send(Buffer.from([0xff, 0xd8, 0xff, 1]), 4200)).toBe(true);
    await expect.poll(() => frames.length).toBe(1);
    expect(seen).toEqual([{ url: '/internal/frames/sid-1', token: 'tok' }]);
    expect(frames[0]).toEqual(encodeFrame({ t_ms: 4200, reason: 'tick' }, Buffer.from([0xff, 0xd8, 0xff, 1])));
    expect(frames[0]!.readUInt32BE(0)).toBe(Buffer.byteLength('{"t_ms":4200,"reason":"tick"}'));
    expect(link.stats).toMatchObject({ sent: 1, dropped_down: 1 });
    link.close();
  });

  it('reconnects after a drop, and stops once perception says the session ended', async () => {
    let connections = 0;
    const { url } = await perception((socket) => {
      connections++;
      socket.close(connections === 1 ? 1011 : SESSION_GONE);
    });
    const link = new PerceptionLink({ baseUrl: url, sessionId: 's', internalToken: 't', log: silentLog, minBackoffMs: 10 });
    await expect.poll(() => connections).toBe(2);
    await new Promise((r) => setTimeout(r, 100));
    expect(connections).toBe(2);
    expect(link.open).toBe(false);
    link.close();
  });
});

describe('screenPipeline', () => {
  it('stops sending, not decoding, while forwarding is off', () => {
    const { procs, spawnImpl } = fakeFfmpeg();
    let forwarding = true;
    const sink = screenPipeline({
      ffmpegPath: 'ffmpeg',
      perceptionUrl: 'ws://127.0.0.1:9', // nothing listens: frames are dropped as "down"
      internalToken: 't',
      forwarding: () => forwarding,
      spawnImpl,
    })(sessionRow(), silentLog);
    sink.frame(AUS[0]!, 1000);
    forwarding = false;
    sink.frame(AUS[1]!, 1100);
    expect(procs).toHaveLength(1);
    expect(Buffer.concat(procs[0]!.written)).toEqual(Buffer.concat([AUS[0]!, AUS[1]!]));
    sink.close();
    expect(procs[0]!.killed).toBe(true);
  });
});
