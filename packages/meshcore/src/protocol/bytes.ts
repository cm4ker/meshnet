/**
 * Reading and writing the little-endian, NUL-padded records the firmware uses.
 *
 * `TextEncoder`/`TextDecoder` are globals in every runtime this runs in (Node,
 * WebView2, WebKit, Chromium), so there is no dependency here.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Decodes up to the first NUL, which is how the firmware terminates fixed fields. */
export function fromUtf8(bytes: Uint8Array): string {
  let end = bytes.indexOf(0);
  if (end < 0) end = bytes.length;
  return decoder.decode(bytes.subarray(0, end));
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, "");
  if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) {
    throw new Error(`not a hex string: ${hex}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export class ByteReader {
  private readonly view: DataView;
  pos = 0;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining(): number {
    return this.bytes.length - this.pos;
  }

  private need(n: number): void {
    if (this.pos + n > this.bytes.length) {
      throw new RangeError(`frame too short: wanted ${n} more byte(s) at ${this.pos} of ${this.bytes.length}`);
    }
  }

  u8(): number {
    this.need(1);
    return this.bytes[this.pos++]!;
  }

  i8(): number {
    this.need(1);
    return this.view.getInt8(this.pos++);
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  /** A copy, so the frame buffer can be reused by the transport. */
  take(n: number): Uint8Array {
    this.need(n);
    const out = this.bytes.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  rest(): Uint8Array {
    return this.take(this.remaining);
  }

  /** A fixed-width NUL-padded string. */
  fixedString(n: number): string {
    return fromUtf8(this.take(n));
  }

  /** Whatever is left, as text. */
  restString(): string {
    return fromUtf8(this.rest());
  }

  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }
}

export class ByteWriter {
  private buf = new Uint8Array(64);
  private view = new DataView(this.buf.buffer);
  private length = 0;

  private grow(n: number): void {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): this {
    this.grow(1);
    this.buf[this.length++] = v & 0xff;
    return this;
  }

  i8(v: number): this {
    this.grow(1);
    this.view.setInt8(this.length++, v);
    return this;
  }

  u16(v: number): this {
    this.grow(2);
    this.view.setUint16(this.length, v, true);
    this.length += 2;
    return this;
  }

  u32(v: number): this {
    this.grow(4);
    this.view.setUint32(this.length, v >>> 0, true);
    this.length += 4;
    return this;
  }

  i32(v: number): this {
    this.grow(4);
    this.view.setInt32(this.length, v, true);
    this.length += 4;
    return this;
  }

  bytes(b: Uint8Array): this {
    this.grow(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
    return this;
  }

  /** UTF-8, no terminator: the frame's own length ends it. */
  string(s: string): this {
    return this.bytes(utf8(s));
  }

  /** A fixed-width field: UTF-8 truncated to fit, NUL-padded, with a terminator kept when it fits. */
  fixedString(s: string, width: number): this {
    const encoded = utf8(s);
    const field = new Uint8Array(width);
    field.set(encoded.subarray(0, Math.min(encoded.length, width)));
    return this.bytes(field);
  }

  zeros(n: number): this {
    this.grow(n);
    this.buf.fill(0, this.length, this.length + n);
    this.length += n;
    return this;
  }

  toBytes(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

/** Seconds since the epoch, as the firmware's RTC counts them. */
export function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * The byte length of a path whose `path_len` byte is given. The top two bits
 * carry the hash size minus one (firmware v1.11+), the low six the number of
 * hashes.
 */
export function pathByteLength(pathLen: number): number {
  return (pathLen & 63) * ((pathLen >> 6) + 1);
}

export function pathHashCount(pathLen: number): number {
  return pathLen & 63;
}
