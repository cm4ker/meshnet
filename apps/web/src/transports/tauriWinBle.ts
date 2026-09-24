/**
 * BLE on Windows through the shell's own GATT commands (`winble.rs`), which
 * exist because btleplug wedges on the firmware's encrypted UART service
 * there. The shell scans, connects and subscribes; frames arrive on a
 * channel; a drop arrives as an event.
 */

import { BaseTransport } from "@meshnet/meshcore";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { NeedsPairingError, type Connector, type FoundDevice } from "./types.js";
import { readSetting, writeSetting } from "../lib/storage.js";

interface Found {
  address: string;
  name: string;
  rssi: number;
}

function pretty(address: string): string {
  return address.match(/.{2}/g)?.join(":") ?? address;
}

class TauriWinBleTransport extends BaseTransport {
  readonly kind = "ble" as const;
  private unlisten: UnlistenFn | null = null;

  constructor(readonly label: string) {
    super();
  }

  async watch(): Promise<void> {
    this.unlisten = await listen<string>("winble:closed", (event) => {
      this.emitClose(new Error(event.payload || "Bluetooth device disconnected"));
    });
  }

  receive(data: number[]): void {
    if (data.length === 0) return;
    this.emitFrame(Uint8Array.from(data));
  }

  async send(frame: Uint8Array): Promise<void> {
    await invoke("winble_send", { data: Array.from(frame) });
  }

  protected async shutdown(): Promise<void> {
    this.unlisten?.();
    this.unlisten = null;
    await invoke("winble_disconnect").catch(() => undefined);
  }
}

/** Radios connected to before, so a launch can reach one without a scan. */
const KNOWN_KEY = "meshnet.winble.known";
/** How the firmware names a radio; anything else with its service is a phone sharing one. */
const RADIO_PREFIX = "MeshCore-";

function known(): FoundDevice[] {
  return readSetting<FoundDevice[]>(KNOWN_KEY, []);
}

function remember(device: FoundDevice): void {
  writeSetting(KNOWN_KEY, [device, ...known().filter((d) => d.id !== device.id)].slice(0, 8));
}

export const tauriWinBleConnector: Connector = {
  id: "tauri-winble",
  kind: "ble",
  title: "Bluetooth",
  description: "Radios in range, found by Windows.",
  mode: "scan",

  async scan(onFound, signal) {
    // One listen of a few seconds at a time, repeated while the panel is open;
    // an abort ends the listen in progress too, so a connection is not kept
    // waiting behind it.
    signal.addEventListener("abort", () => void invoke("winble_stop_scan").catch(() => undefined), { once: true });
    while (!signal.aborted) {
      const list = await invoke<Found[]>("winble_scan", { timeoutMs: 4000 });
      if (signal.aborted) return;
      onFound(list.map((f) => ({ id: f.address, name: f.name, detail: pretty(f.address), rssi: f.rssi })));
    }
  },

  async remembered() {
    return known();
  },

  async connect(device) {
    if (!device) throw new Error("pick a radio from the list");
    let transport: TauriWinBleTransport | null = null;
    const channel = new Channel<number[]>();
    channel.onmessage = (data) => transport?.receive(data);
    const open = () => invoke<{ name: string }>("winble_connect", { address: device.id, onFrame: channel });
    let name: string;
    try {
      try {
        ({ name } = await open());
      } catch (error) {
        // A phone sharing its radio has no PIN to type: it asks on its own
        // screen, and Windows takes any answer. So it is paired at once, and
        // only a radio (named MeshCore-…) is left to the PIN prompt.
        if (!/NEEDS_PAIRING/.test(String(error)) || device.name.startsWith(RADIO_PREFIX)) throw error;
        await invoke<string>("winble_pair", { address: device.id, pin: "" });
        ({ name } = await open());
      }
    } catch (error) {
      const text = String(error);
      if (/NEEDS_PAIRING/.test(text)) {
        throw new NeedsPairingError(`${device.name} is not paired with this computer, or no longer trusts the pairing.`);
      }
      throw new Error(text);
    }
    transport = new TauriWinBleTransport(name || device.name);
    await transport.watch();
    remember({ ...device, name: name || device.name });
    return transport;
  },

  async pair(device, pin) {
    await invoke<string>("winble_pair", { address: device.id, pin });
  },
};
