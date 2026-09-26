import { test } from "node:test";
import assert from "node:assert/strict";
import type { WatchHandlers, WatchOptions } from "tauri-plugin-serialplugin-api";
import { TauriSerialTransport } from "./tauriSerial.js";

class FakePort {
  handlers: WatchHandlers | null = null;
  options: WatchOptions | undefined;
  watchError: Error | null = null;
  closes = 0;
  lines: string[] = [];
  async open() { return "COM6"; }
  async writeDataTerminalReady(level: boolean) { this.lines.push(`dtr:${level}`); }
  async writeRequestToSend(level: boolean) { this.lines.push(`rts:${level}`); }
  async watch(handlers: WatchHandlers, options?: WatchOptions) {
    if (this.watchError) throw this.watchError;
    this.handlers = handlers;
    this.options = options;
    return { channelId: 1, unwatch: async () => undefined };
  }
  async writeBinary(bytes: Uint8Array | number[]) { return bytes.length; }
  async close() { this.closes += 1; }
}

test("USB watch preserves binary bytes and reassembles split replies", async () => {
  const port = new FakePort();
  const transport = new TauriSerialTransport(port, "COM6");
  const received: Uint8Array[] = [];
  transport.onFrame((frame) => received.push(frame));
  await transport.open();
  // A TinyUSB radio answers only once the host raises DTR.
  assert.deepEqual(port.lines, ["dtr:true", "rts:true"]);
  assert.equal(port.options?.decode, false);
  assert.equal(port.options?.routeUrc, false);
  port.handlers!.onData(new Uint8Array([0x3e, 3]));
  port.handlers!.onData(new Uint8Array([0, 0x88, 0xff, 0x0a, 0x3e, 1, 0, 10]));
  assert.deepEqual(received, [new Uint8Array([0x88, 0xff, 0x0a]), new Uint8Array([10])]);
  await transport.close();
});

test("a watch failure releases the opened USB port", async () => {
  const port = new FakePort();
  port.watchError = new Error("watch failed");
  const transport = new TauriSerialTransport(port, "COM6");
  await assert.rejects(transport.open(), /watch failed/);
  assert.equal(port.closes, 1);
  assert.equal(transport.isClosed, true);
});

test("USB errors release the native port and report the first failure once", async () => {
  const port = new FakePort();
  const transport = new TauriSerialTransport(port, "COM6");
  const failures: (Error | null)[] = [];
  transport.onClose((reason) => failures.push(reason));
  await transport.open();
  port.handlers!.onError?.("read failed");
  port.handlers!.onDisconnect?.("port closed");
  await transport.close();
  assert.equal(port.closes, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.message, "read failed");
  await assert.rejects(transport.send(new Uint8Array([10])), /port closed/);
});
