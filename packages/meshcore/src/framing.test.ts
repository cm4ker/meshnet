import { test } from "node:test";
import assert from "node:assert/strict";
import { frameForStream, StreamFrameDecoder } from "./framing.js";

test("an outgoing frame is '<', a little-endian length, and the payload", () => {
  const bytes = frameForStream(new Uint8Array([1, 2, 3]));
  assert.deepEqual([...bytes], [0x3c, 3, 0, 1, 2, 3]);
});

test("the decoder reassembles frames across arbitrary chunk boundaries", () => {
  const wire = new Uint8Array([0x3e, 3, 0, 10, 11, 12, 0x3e, 1, 0, 99]);
  const decoder = new StreamFrameDecoder();
  const frames: Uint8Array[] = [];
  for (const byte of wire) frames.push(...decoder.push(new Uint8Array([byte])));
  assert.equal(frames.length, 2);
  assert.deepEqual([...frames[0]!], [10, 11, 12]);
  assert.deepEqual([...frames[1]!], [99]);
});

test("bytes before a marker are a boot banner and are dropped", () => {
  const decoder = new StreamFrameDecoder();
  const banner = new TextEncoder().encode("MeshCore booting...\r\n");
  const frames = decoder.push(new Uint8Array([...banner, 0x3e, 2, 0, 7, 8]));
  assert.equal(frames.length, 1);
  assert.deepEqual([...frames[0]!], [7, 8]);
});

test("an absurd length is a marker inside text, and the search resumes", () => {
  const decoder = new StreamFrameDecoder();
  // '>' then a length of 0xffff, then a real frame.
  const frames = decoder.push(new Uint8Array([0x3e, 0xff, 0xff, 0x3e, 1, 0, 5]));
  assert.equal(frames.length, 1);
  assert.deepEqual([...frames[0]!], [5]);
});

test("the direction byte for the app is not mistaken for a frame from the radio", () => {
  const decoder = new StreamFrameDecoder();
  assert.equal(decoder.push(new Uint8Array([0x3c, 1, 0, 5])).length, 0);
});
