/**
 * The byte-stream framing of the USB serial (and TCP) link. BLE needs none:
 * one frame is one characteristic write or notification.
 *
 * App → radio: `'<'`, length as two little-endian bytes, payload.
 * Radio → app: `'>'`, the same.
 *
 * The decoder is the firmware's `checkRecvFrame` mirrored: it looks for the
 * marker, reads the length, then collects. Anything before a marker is
 * dropped, which is how it resyncs after a boot banner or a torn frame.
 */

import { MAX_FRAME_SIZE } from "./protocol/codes.js";

const APP_TO_RADIO = 0x3c; // '<'
const RADIO_TO_APP = 0x3e; // '>'

export function frameForStream(payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_FRAME_SIZE) {
    throw new Error(`frame of ${payload.length} bytes exceeds the radio's ${MAX_FRAME_SIZE}`);
  }
  const out = new Uint8Array(3 + payload.length);
  out[0] = APP_TO_RADIO;
  out[1] = payload.length & 0xff;
  out[2] = payload.length >> 8;
  out.set(payload, 3);
  return out;
}

export class StreamFrameDecoder {
  private state: "idle" | "len1" | "len2" | "body" = "idle";
  private length = 0;
  private body = new Uint8Array(0);
  private filled = 0;

  /** Feeds a chunk and returns every complete frame it finished. */
  push(chunk: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = [];
    for (const byte of chunk) {
      switch (this.state) {
        case "idle":
          if (byte === RADIO_TO_APP) this.state = "len1";
          break;
        case "len1":
          this.length = byte;
          this.state = "len2";
          break;
        case "len2":
          this.length |= byte << 8;
          if (this.length === 0 || this.length > MAX_FRAME_SIZE * 4) {
            // An empty frame is nothing; an absurd length is a marker byte
            // inside a boot log. Both go back to looking for a marker.
            this.state = "idle";
          } else {
            this.body = new Uint8Array(this.length);
            this.filled = 0;
            this.state = "body";
          }
          break;
        case "body":
          this.body[this.filled++] = byte;
          if (this.filled >= this.length) {
            frames.push(this.body);
            this.state = "idle";
          }
          break;
      }
    }
    return frames;
  }

  reset(): void {
    this.state = "idle";
  }
}
