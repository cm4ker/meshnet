/**
 * Web Serial, for a browser tab on the desktop: the radio over its USB cable.
 */

import { BaseTransport, frameForStream, SERIAL_BAUD, StreamFrameDecoder } from "@meshnet/meshcore";
import type { Connector, FoundDevice } from "./types.js";

class WebSerialTransport extends BaseTransport {
  readonly kind = "serial" as const;
  readonly label: string;
  private readonly decoder = new StreamFrameDecoder();
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly port: SerialPort) {
    super();
    this.label = describe(port);
  }

  async open(): Promise<void> {
    await this.port.open({ baudRate: SERIAL_BAUD });
    if (!this.port.readable || !this.port.writable) throw new Error("the port opened without streams");
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    void this.readLoop(this.reader);
  }

  private async readLoop(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) for (const frame of this.decoder.push(value)) this.emitFrame(frame);
      }
      this.emitClose(new Error("the port closed"));
    } catch (error) {
      this.emitClose(error instanceof Error ? error : new Error(String(error)));
    }
  }

  send(frame: Uint8Array): Promise<void> {
    const writer = this.writer;
    if (!writer) return Promise.reject(new Error("port not open"));
    const bytes = frameForStream(frame);
    // Writes are serialised: a second `write` before the first settles is an error on some stacks.
    this.writing = this.writing.then(() => writer.write(bytes));
    return this.writing;
  }

  protected async shutdown(): Promise<void> {
    try {
      await this.reader?.cancel();
    } catch {
      // Already closed.
    }
    this.reader?.releaseLock();
    try {
      await this.writer?.close();
    } catch {
      // Already closed.
    }
    this.writer?.releaseLock();
    try {
      await this.port.close();
    } catch {
      // Already closed.
    }
  }
}

function describe(port: SerialPort): string {
  const info = port.getInfo();
  if (info.usbVendorId !== undefined) {
    return `USB ${info.usbVendorId.toString(16).padStart(4, "0")}:${(info.usbProductId ?? 0).toString(16).padStart(4, "0")}`;
  }
  return "Serial port";
}

function found(port: SerialPort, index: number): FoundDevice {
  return { id: String(index), name: describe(port), detail: null, rssi: null };
}

export const webSerialConnector: Connector = {
  id: "web-serial",
  kind: "serial",
  title: "USB",
  description: "The browser's port chooser.",
  mode: "picker",

  async remembered() {
    try {
      return (await navigator.serial.getPorts()).map(found);
    } catch {
      return [];
    }
  },

  async connect(device) {
    let port: SerialPort | undefined;
    if (device) {
      const ports = await navigator.serial.getPorts();
      port = ports[Number(device.id)];
    }
    port ??= await navigator.serial.requestPort();
    const transport = new WebSerialTransport(port);
    await transport.open();
    return transport;
  },
};
