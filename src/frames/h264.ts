/** NAL unit types (H.264 Table 7-1) we care about. */
const NAL = { idr: 5, sps: 7 } as const;

/** Types of the NAL units in an Annex-B buffer (start codes 00 00 01 or 00 00 00 01). */
export function nalTypes(buf: Buffer): number[] {
  const types: number[] = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      types.push(buf[i + 3]! & 0x1f);
      i += 2;
    }
  }
  return types;
}

/** Whether a decoder can start here: the access unit carries an SPS or an IDR slice. */
export function startsDecoding(buf: Buffer): boolean {
  return nalTypes(buf).some((t) => t === NAL.sps || t === NAL.idr);
}

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

/**
 * Splits ffmpeg's concatenated MJPEG output into JPEGs. In entropy-coded data a 0xFF byte is always
 * followed by 0x00, so FF D9 only ever marks the end of an image.
 */
export class JpegSplitter {
  private pending: Buffer = Buffer.alloc(0);

  /** Feeds bytes; returns the JPEGs completed by them. */
  push(chunk: Buffer): Buffer[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const out: Buffer[] = [];
    for (;;) {
      const start = this.pending.indexOf(SOI);
      if (start < 0) {
        this.pending = Buffer.alloc(0);
        break;
      }
      const end = this.pending.indexOf(EOI, start + 2);
      if (end < 0) {
        this.pending = this.pending.subarray(start);
        break;
      }
      out.push(Buffer.from(this.pending.subarray(start, end + 2)));
      this.pending = this.pending.subarray(end + 2);
    }
    return out;
  }
}
