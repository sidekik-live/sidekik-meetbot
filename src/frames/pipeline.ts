import type { ScreenSinkFactory } from '../services/realtime.js';
import { H264Decoder, type SpawnFfmpeg } from './decoder.js';
import { PerceptionLink } from './perception.js';

export type ScreenPipelineOptions = {
  ffmpegPath: string;
  perceptionUrl: string;
  internalToken: string;
  /** False while the session is off the record: frames are decoded but not sent (DESIGN §4). */
  forwarding?: (sessionId: string) => boolean;
  spawnImpl?: SpawnFfmpeg;
};

/**
 * The screen sink for a session: Recall's H.264 → ffmpeg (1 fps JPEG) → perception. Opened on the
 * first screen-share frame. Each JPEG carries the session time of the latest access unit fed in.
 */
export function screenPipeline(opts: ScreenPipelineOptions): ScreenSinkFactory {
  return (session, log) => {
    let lastTMs = 0;
    let offRecordDropped = 0;
    const link = new PerceptionLink({
      baseUrl: opts.perceptionUrl,
      sessionId: session.id,
      internalToken: opts.internalToken,
      log,
    });
    const decoder = new H264Decoder({
      ffmpegPath: opts.ffmpegPath,
      log,
      ...(opts.spawnImpl && { spawnImpl: opts.spawnImpl }),
      onJpeg: (jpeg) => {
        if (opts.forwarding && !opts.forwarding(session.id)) {
          offRecordDropped++;
          return;
        }
        link.send(jpeg, lastTMs);
      },
    });

    return {
      frame(h264, tMs) {
        lastTMs = tMs;
        decoder.write(h264);
      },
      stop() {
        decoder.reset();
      },
      close() {
        decoder.close();
        link.close();
        log.info({ decoder: decoder.stats, perception: link.stats, offrecord_dropped: offRecordDropped }, 'screen pipeline closed');
      },
    };
  };
}
