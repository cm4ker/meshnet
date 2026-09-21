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

test("a partial USB frame expires so the next reply is not swallowed as its body", () => {
  for (const partial of [[0x3e], [0x3e, 50], [0x3e, 50, 0, 17, 0]]) {
    const decoder = new StreamFrameDecoder();
    assert.deepEqual(decoder.push(new Uint8Array(partial), 0), []);
    assert.deepEqual(decoder.push(new Uint8Array(), 999), []);
    assert.deepEqual(decoder.push(new Uint8Array([0x3e, 1, 0, 10]), 1000), [new Uint8Array([10])]);
  }
});

test("short gaps and markers inside binary payloads preserve a fragmented frame", () => {
  const decoder = new StreamFrameDecoder();
  assert.deepEqual(decoder.push(new Uint8Array([0x3e, 4, 0, 17]), 0), []);
  assert.deepEqual(decoder.push(new Uint8Array([0x3e, 1]), 100), []);
  assert.deepEqual(decoder.push(new Uint8Array([0]), 200), [new Uint8Array([17, 0x3e, 1, 0])]);
});

test("impossible lengths and overlapping headers do not hide the next reply", () => {
  for (const prefix of [[0x3e, 177, 0], [0x3e], [0x3e, 100]]) {
    const decoder = new StreamFrameDecoder();
    assert.deepEqual(decoder.push(new Uint8Array([...prefix, 0x3e, 1, 0, 10])), [new Uint8Array([10])]);
  }
});
