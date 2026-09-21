/**
 * BLE through the desktop shell's plugin (`tauri-plugin-blec`, btleplug
 * underneath): the shell scans and lists, the client picks. One connection at
 * a time is what the plugin offers, which is one more than this client needs.
 */

import { BaseTransport, BLE } from "@meshnet/meshcore";
import type { Connector, FoundDevice } from "./types.js";

type Blec = typeof import("@mnlphlp/plugin-blec");

let plugin: Promise<Blec> | null = null;
function blec(): Promise<Blec> {
  plugin ??= import("@mnlphlp/plugin-blec");
  return plugin;
}

class TauriBleTransport extends BaseTransport {
  readonly kind = "ble" as const;

  constructor(
    private readonly api: Blec,
    readonly label: string,
  ) {
    super();
  }

  async send(frame: Uint8Array): Promise<void> {
    // With response, on purpose. The firmware's UART characteristics demand an
    // encrypted, MITM-protected link (the PIN pairing); an unacknowledged
    // write to one over a link that is not yet encrypted is dropped by the
    // stack without a word, whereas an acknowledged write either makes
    // Windows raise the link to the bond's encryption or fails out loud.
    try {
      await this.api.send(BLE.rx, Array.from(frame), "withResponse", BLE.service);
    } catch (error) {
      throw new Error(explainBleError(error));
    }
  }

  receive(data: number[]): void {
    if (data.length === 0) return;
    this.emitFrame(Uint8Array.from(data));
  }

  onDropped(): void {
    this.emitClose(new Error("Bluetooth device disconnected"));
  }

  protected async shutdown(): Promise<void> {
    try {
      await this.api.unsubscribe(BLE.tx, BLE.service);
    } catch {
      // Already gone.
    }
    try {
      await this.api.disconnect();
    } catch {
      // Already gone.
    }
  }
}

/** The words the stack uses when the bond is missing or stale, turned into what to do about it. */
function explainBleError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/auth|encrypt|pair|bond|access.?denied|insufficient/i.test(text)) {
    return `${text}. The radio wants a paired link: pair it in Windows Settings → Bluetooth with its PIN (123456 unless changed), or remove and pair again if it was re-flashed.`;
  }
  return text;
}

function looksLikeRadio(device: import("@mnlphlp/plugin-blec").BleDevice): boolean {
  return (
    device.services.some((s) => s.toLowerCase() === BLE.service) ||
    (device.name?.startsWith(BLE.namePrefix) ?? false)
  );
}

function found(device: import("@mnlphlp/plugin-blec").BleDevice): FoundDevice {
  return {
    id: device.address,
    name: device.name || "MeshCore",
    detail: device.address,
    rssi: device.rssi || null,
  };
}

const SCAN_MS = 10_000;

export const tauriBleConnector: Connector = {
  id: "tauri-ble",
  kind: "ble",
  title: "Bluetooth",
  description: "Radios in range, found by the shell.",
  mode: "scan",

  async scan(onFound, signal) {
    const api = await blec();
    if (!(await api.checkPermissions(true))) throw new Error("Bluetooth permission was not granted");
    const seen = new Map<string, FoundDevice>();
    const stop = () => api.stopScan().catch(() => undefined);
    signal.addEventListener("abort", stop, { once: true });
    await api.startScan((devices) => {
      for (const d of devices) if (looksLikeRadio(d)) seen.set(d.address, found(d));
      onFound([...seen.values()]);
    }, SCAN_MS);
  },

  async remembered() {
    return [];
  },

  async connect(device) {
    if (!device) throw new Error("pick a radio from the list");
    const api = await blec();
    // The plugin can only connect to a peripheral its adapter has seen; a
    // short scan is what makes a remembered address reachable again.
    await ensureSeen(api, device.id);
    let transport: TauriBleTransport | null = null;
    await api.connect(device.id, () => transport?.onDropped());
    transport = new TauriBleTransport(api, device.name);
    await api.subscribe(BLE.tx, BLE.service, (data) => transport?.receive(data));
    return transport;
  },
};

async function ensureSeen(api: Blec, address: string): Promise<void> {
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      api.stopScan().catch(() => undefined);
      resolve();
    };
    api
      .startScan((devices) => {
        if (devices.some((d) => d.address === address)) finish();
      }, 6000)
      .then(finish, finish);
  });
}
