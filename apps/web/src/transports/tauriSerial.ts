/**
 * The USB cable through the desktop shell's serial plugin. Ports are listed by
 * the shell; the client opens one at the radio's rate and frames the stream.
 */

import { BaseTransport, frameForStream, SERIAL_BAUD, StreamFrameDecoder } from "@meshnet/meshcore";
import type { Connector, FoundDevice } from "./types.js";

type SerialModule = typeof import("tauri-plugin-serialplugin-api");

let plugin: Promise<SerialModule> | null = null;
function serial(): Promise<SerialModule> {
  plugin ??= import("tauri-plugin-serialplugin-api");
  return plugin;
}

class TauriSerialTransport extends BaseTransport {
  readonly kind = "serial" as const;
  private readonly decoder = new StreamFrameDecoder();

  constructor(
    private readonly port: InstanceType<SerialModule["SerialPort"]>,
    readonly label: string,
  ) {
    super();
  }

  async open(): Promise<void> {
    await this.port.open();
    await this.port.watch(
      {
        onData: (data) => {
          const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
          for (const frame of this.decoder.push(bytes)) this.emitFrame(frame);
        },
        onDisconnect: (reason) => this.emitClose(new Error(reason || "the port closed")),
        onError: (message) => this.emitClose(new Error(message)),
      },
      { decode: false, timeout: 20 },
    );
  }

  async send(frame: Uint8Array): Promise<void> {
    await this.port.writeBinary(frameForStream(frame));
  }

  protected async shutdown(): Promise<void> {
    try {
      await this.port.close();
    } catch {
      // Already closed.
    }
  }
}

export const tauriSerialConnector: Connector = {
  id: "tauri-serial",
  kind: "serial",
  title: "USB",
  description: "Serial ports on this machine.",
  mode: "scan",

  async scan(onFound, signal) {
    const { SerialPort } = await serial();
    const list = async () => {
      const ports = await SerialPort.available_ports();
      const devices: FoundDevice[] = Object.entries(ports).map(([path, info]) => ({
        id: path,
        name: path,
        detail: [info.manufacturer, info.product].filter((s) => s && s !== "Unknown").join(" ") || info.type || null,
        rssi: null,
      }));
      devices.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
      onFound(devices);
    };
    await list();
    const timer = setInterval(() => void list().catch(() => undefined), 2000);
    signal.addEventListener("abort", () => clearInterval(timer), { once: true });
  },

  async remembered() {
    return [];
  },

  async connect(device) {
    if (!device) throw new Error("pick a port from the list");
    const { SerialPort } = await serial();
    const port = new SerialPort({ path: device.id, baudRate: SERIAL_BAUD });
    const transport = new TauriSerialTransport(port, device.name);
    await transport.open();
    return transport;
  },
};
