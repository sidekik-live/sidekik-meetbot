/**
 * Which sessions are off the record, from lifecycle `offrecord_on/off` (and the session row when a
 * bot's socket opens). While a session is off, its screen frames are decoded but not sent.
 */
export class OffRecordState {
  private readonly off = new Set<string>();

  set(sessionId: string, on: boolean): void {
    if (on) this.off.add(sessionId);
    else this.off.delete(sessionId);
  }

  isOff(sessionId: string): boolean {
    return this.off.has(sessionId);
  }

  forget(sessionId: string): void {
    this.off.delete(sessionId);
  }
}
