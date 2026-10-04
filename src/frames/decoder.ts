import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { FastifyBaseLogger } from 'fastify';
import { JpegSplitter, startsDecoding } from './h264.js';

type FfmpegProcess = ChildProcessByStdio<Writable, Readable, Readable>;
export type SpawnFfmpeg = (path: string, args: string[]) => FfmpegProcess;

export type DecoderOptions = {
  ffmpegPath: string;
  onJpeg: (jpeg: Buffer) => void;
  log: FastifyBaseLogger;
  /** JPEGs per second out of ffmpeg (DESIGN §4: 1). */
  fps?: number;
  maxWidth?: number;
  /** ffmpeg's unread input above which access units are dropped instead of queued. */
  maxBacklogBytes?: number;
  spawnImpl?: SpawnFfmpeg;
};

/**
 * ffmpeg arguments: raw H.264 in, `fps` JPEGs out. Raw H.264 has no timestamps, so packets are
 * stamped with the wall clock as they arrive and the fps filter samples real time. A small probe, a
 * single decoder thread (no frame-threading delay) and a flush per JPEG keep latency down: the first
 * JPEG comes ~2.5 s after the share starts, then one per second.
 */
export function ffmpegArgs(fps: number, maxWidth: number): string[] {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-probesize', '2048',
    '-analyzeduration', '0',
    '-threads', '1',
    '-use_wallclock_as_timestamps', '1',
    '-f', 'h264',
    '-i', 'pipe:0',
    '-vf', `fps=${fps},scale='min(${maxWidth},iw)':-2`,
    '-f', 'image2pipe',
    '-c:v', 'mjpeg',
    '-q:v', '5',
    '-flush_packets', '1',
    'pipe:1',
  ];
}

/**
 * One long-lived ffmpeg per screen share (DESIGN §4). Access units are written as they come; nothing
 * is queued here: until a keyframe (SPS or IDR) arrives, and whenever ffmpeg falls behind, units are
 * dropped and the decoder waits for the next keyframe, so it never decodes a broken reference.
 * ffmpeg is started on the first keyframe and again after it exits.
 */
export class H264Decoder {
  private proc: FfmpegProcess | undefined;
  private synced = false;
  private closed = false;
  private stderrTail = '';
  readonly stats = { written: 0, dropped_unsynced: 0, dropped_backlog: 0, jpegs: 0, restarts: 0 };

  constructor(private readonly opts: DecoderOptions) {}

  write(au: Buffer): void {
    if (this.closed) return;
    if (!this.synced) {
      if (!startsDecoding(au)) {
        this.stats.dropped_unsynced++;
        return;
      }
      this.synced = true;
    }
    const proc = this.proc ?? this.start();
    if (proc.stdin.writableLength > (this.opts.maxBacklogBytes ?? 2 * 1024 * 1024)) {
      // Behind: drop this unit, and every one until the next keyframe.
      this.stats.dropped_backlog++;
      this.synced = false;
      return;
    }
    proc.stdin.write(au);
    this.stats.written++;
  }

  /** The stream changed (another sharer, or the share restarted): start over at the next keyframe. */
  reset(): void {
    this.stop();
    this.synced = false;
  }

  close(): void {
    this.closed = true;
    this.stop();
  }

  private start(): FfmpegProcess {
    const spawnImpl = this.opts.spawnImpl ?? ((path, args) => spawn(path, args, { stdio: ['pipe', 'pipe', 'pipe'] }));
    const proc = spawnImpl(this.opts.ffmpegPath, ffmpegArgs(this.opts.fps ?? 1, this.opts.maxWidth ?? 1280));
    this.proc = proc;
    if (this.stats.written > 0) this.stats.restarts++;
    const splitter = new JpegSplitter();

    proc.stdout.on('data', (chunk: Buffer) => {
      for (const jpeg of splitter.push(chunk)) {
        this.stats.jpegs++;
        this.opts.onJpeg(jpeg);
      }
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-500);
    });
    // EPIPE when ffmpeg dies mid-write; 'exit' below handles it.
    proc.stdin.on('error', () => {});
    proc.on('error', (err) => this.opts.log.error({ err }, 'ffmpeg failed to start'));
    proc.on('exit', (code, signal) => {
      if (this.proc !== proc) return;
      this.proc = undefined;
      this.synced = false;
      if (!this.closed) this.opts.log.warn({ code, signal, stderr: this.stderrTail.trim() }, 'ffmpeg exited; restarting at the next keyframe');
    });
    return proc;
  }

  private stop(): void {
    const proc = this.proc;
    this.proc = undefined;
    if (!proc) return;
    proc.stdin.end();
    proc.kill('SIGKILL');
  }
}
