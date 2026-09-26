/**
 * The USB cable through the desktop shell's serial plugin. Ports are listed by
 * the shell; the client opens one at the radio's rate and frames the stream.
 */

import { BaseTransport, frameForStream, SERIAL_BAUD, StreamFrameDecoder } from "@meshnet/meshcore";
import type { Connector, FoundDevice } from "./types.js";
import { t } from "../i18n/index.js";

type SerialModule = typeof import("tauri-plugin-serialplugin-api");

let plugin: Promise<SerialModule> | null = null;
function serial(): Promise<SerialModule> {
  plugin ??= import("tauri-plugin-serialplugin-api");
  return plugin;
}

export class TauriSerialTransport extends BaseTransport {
  readonly kind = "serial" as const;
  private readonly decoder = new StreamFrameDecoder();

  constructor(
    private readonly port: Pick<InstanceType<SerialModule["SerialPort"]>, "open" | "watch" | "writeBinary" | "close" | "writeDataTerminalReady" | "writeRequestToSend">,
    readonly label: string,
  ) {
    super();
  }

  async open(): Promise<void> {
    try {
      await this.port.open();
      // On Windows the port opens with DTR off, and a radio on TinyUSB (the nRF52 boards: T-Echo, RAK)
      // reads what it is sent but writes nothing back until the host raises it. Both lines up, as a
      // browser's Web Serial and pyserial open a port.
      await this.port.writeDataTerminalReady(true);
      await this.port.writeRequestToSend(true);
      await this.port.watch(
        {
          onData: (data) => {
            const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
            for (const frame of this.decoder.push(bytes)) this.emitFrame(frame);
          },
          onDisconnect: (reason) => this.fail(new Error(reason || "the port closed")),
          onError: (message) => this.fail(new Error(message)),
        },
        { decode: false, routeUrc: false, timeout: 20 },
      );
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private fail(reason: Error): void {
    // BaseTransport.close() is a no-op after emitClose, so release the native
    // port here too; otherwise the next connection can find it still occupied.
    if (this.isClosed) return;
    this.emitClose(reason);
    void this.shutdown();
  }

  async send(frame: Uint8Array): Promise<void> {
    if (this.isClosed) throw new Error(t("connect.error.portClosed"));
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
  get title() {
    return t("connect.transport.usb");
  },
  get description() {
    return t("connect.describe.shellSerial");
  },
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
    if (!device) throw new Error(t("connect.error.pickPort"));
    const { SerialPort } = await serial();
    const port = new SerialPort({ path: device.id, baudRate: SERIAL_BAUD });
    const transport = new TauriSerialTransport(port, device.name);
    await transport.open();
    return transport;
  },
};
