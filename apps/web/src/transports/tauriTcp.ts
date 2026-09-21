/**
 * A radio on the network, from the desktop (see `tcp.ts` for what the
 * firmware serves). The socket is the shell's own (`tcp.rs`): bytes arrive on
 * one channel, the end of the connection on another; the framing is done
 * here.
 */

import { BaseTransport, frameForStream, StreamFrameDecoder } from "@meshnet/meshcore";
import { Channel, invoke } from "@tauri-apps/api/core";
import { addressOf, knownAddresses, rememberAddress, TCP_CONNECT_TIMEOUT_S } from "./tcp.js";
import type { Connector } from "./types.js";

class TauriTcpTransport extends BaseTransport {
  readonly kind = "tcp" as const;
  private readonly decoder = new StreamFrameDecoder();
  private id: number | null = null;

  constructor(readonly label: string) {
    super();
  }

  /** Connects. The channels belong to this transport before the socket exists, so a drop right after the connect still reaches it. */
  async open(host: string, port: number): Promise<void> {
    const onData = new Channel<number[]>();
    onData.onmessage = (data) => {
      for (const frame of this.decoder.push(Uint8Array.from(data))) this.emitFrame(frame);
    };
    const onClosed = new Channel<string>();
    onClosed.onmessage = (reason) => this.emitClose(new Error(reason || "the radio closed the connection"));
    this.id = await invoke<number>("tcp_open", { host, port, timeoutMs: TCP_CONNECT_TIMEOUT_S * 1000, onData, onClosed });
  }

  async send(frame: Uint8Array): Promise<void> {
    if (this.isClosed || this.id === null) throw new Error("connection closed");
    await invoke("tcp_write", { id: this.id, data: Array.from(frameForStream(frame)) });
  }

  protected async shutdown(): Promise<void> {
    if (this.id === null) return;
    await invoke("tcp_close", { id: this.id }).catch(() => undefined);
  }
}

export const tauriTcpConnector: Connector = {
  id: "tauri-tcp",
  kind: "tcp",
  title: "Wi-Fi",
  description: "A radio on the network, by its address. Companion firmware built with Wi-Fi listens on port 5000.",
  mode: "address",

  async remembered() {
    return knownAddresses();
  },

  async connect(device) {
    if (!device) throw new Error("type the radio's address");
    const { host, port } = addressOf(device);
    const transport = new TauriTcpTransport(device.name);
    try {
      await transport.open(host, port);
    } catch (error) {
      throw new Error(String(error));
    }
    rememberAddress(device);
    return transport;
  },
};
