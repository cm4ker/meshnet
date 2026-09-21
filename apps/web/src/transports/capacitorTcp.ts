/**
 * A radio on the network, from a phone. Companion firmware built with Wi-Fi
 * (ESP32 boards, `WIFI_SSID` at build time) listens on TCP port 5000 and
 * speaks exactly what its USB serial speaks: `'<'`/`'>'`, a little-endian
 * length and the frame. The socket is the app's own plugin, `MeshTcp`
 * (`MeshTcpPlugin.swift` on iOS, `MeshTcpPlugin.java` on Android); the
 * framing is done here.
 */

import type { PluginListenerHandle } from "@capacitor/core";
import { BaseTransport, frameForStream, StreamFrameDecoder } from "@meshnet/meshcore";
import type { Connector, FoundDevice } from "./types.js";
import { readSetting, writeSetting } from "../lib/storage.js";

interface MeshTcpPlugin {
  open(options: { host: string; port: number; timeout?: number }): Promise<{ id: string }>;
  write(options: { id: string; data: string }): Promise<void>;
  close(options: { id: string }): Promise<void>;
  addListener(event: "data", listener: (event: { id: string; data: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: "closed", listener: (event: { id: string; error?: string }) => void): Promise<PluginListenerHandle>;
}

let plugin: Promise<MeshTcpPlugin> | null = null;
function tcp(): Promise<MeshTcpPlugin> {
  plugin ??= import("@capacitor/core").then(({ registerPlugin }) => registerPlugin<MeshTcpPlugin>("MeshTcp"));
  return plugin;
}

/** The port companion firmware listens on unless it was built with another. */
export const DEFAULT_TCP_PORT = 5000;

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function fromBase64(data: string): Uint8Array {
  const text = atob(data);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

/** Open connections by the plugin's id; the plugin's events carry the id. */
const routes = new Map<string, CapacitorTcpTransport>();

let listening: Promise<unknown> | null = null;

/** One listener per event for the app's lifetime, in place before the first connection can say anything. */
function listen(api: MeshTcpPlugin): Promise<unknown> {
  listening ??= Promise.all([
    api.addListener("data", (event) => routes.get(event.id)?.receive(event.data)),
    api.addListener("closed", (event) => routes.get(event.id)?.dropped(event.error)),
  ]);
  return listening;
}

class CapacitorTcpTransport extends BaseTransport {
  readonly kind = "tcp" as const;
  private readonly decoder = new StreamFrameDecoder();

  constructor(
    private readonly api: MeshTcpPlugin,
    private readonly id: string,
    readonly label: string,
  ) {
    super();
    routes.set(id, this);
  }

  receive(data: string): void {
    for (const frame of this.decoder.push(fromBase64(data))) this.emitFrame(frame);
  }

  dropped(error: string | undefined): void {
    routes.delete(this.id);
    this.emitClose(new Error(error || "the radio closed the connection"));
  }

  async send(frame: Uint8Array): Promise<void> {
    if (this.isClosed) throw new Error("connection closed");
    await this.api.write({ id: this.id, data: toBase64(frameForStream(frame)) });
  }

  protected async shutdown(): Promise<void> {
    routes.delete(this.id);
    await this.api.close({ id: this.id }).catch(() => undefined);
  }
}

/** `host:port`, with the port the firmware uses when none is given. Brackets keep an IPv6 address whole. */
export function parseAddress(text: string): { host: string; port: number } | null {
  const value = text.trim();
  if (!value) return null;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
  if (bracketed) return { host: bracketed[1]!, port: bracketed[2] ? Number(bracketed[2]) : DEFAULT_TCP_PORT };
  const colons = value.split(":").length - 1;
  if (colons === 1) {
    const [host, port] = value.split(":") as [string, string];
    if (!host || !/^\d+$/.test(port)) return null;
    return { host, port: Number(port) };
  }
  // No colon is a bare host; several are an IPv6 address with no port.
  return { host: value, port: DEFAULT_TCP_PORT };
}

export function addressLabel(host: string, port: number): string {
  const shown = host.includes(":") ? `[${host}]` : host;
  return port === DEFAULT_TCP_PORT ? shown : `${shown}:${port}`;
}

/** Addresses connected to before, newest first. */
const KNOWN_KEY = "meshnet.tcp.known";

function known(): FoundDevice[] {
  return readSetting<FoundDevice[]>(KNOWN_KEY, []);
}

function remember(device: FoundDevice): void {
  writeSetting(KNOWN_KEY, [device, ...known().filter((d) => d.id !== device.id)].slice(0, 8));
}

export const capacitorTcpConnector: Connector = {
  id: "cap-tcp",
  kind: "tcp",
  title: "Wi-Fi",
  description: "A radio on the network, by its address. Companion firmware built with Wi-Fi listens on port 5000.",
  mode: "address",

  async remembered() {
    return known();
  },

  async connect(device) {
    if (!device) throw new Error("type the radio's address");
    const address = parseAddress(device.id);
    if (!address || address.port < 1 || address.port > 65535) throw new Error(`${device.id} is not an address`);
    const api = await tcp();
    await listen(api);
    const { id } = await api.open({ ...address, timeout: 10 });
    const transport = new CapacitorTcpTransport(api, id, device.name);
    remember(device);
    return transport;
  },
};

/** What the connect screen hands `connect` for a typed address. */
export function addressDevice(text: string): FoundDevice | null {
  const address = parseAddress(text);
  if (!address) return null;
  const label = addressLabel(address.host, address.port);
  return { id: label, name: label, detail: null, rssi: null };
}
