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
    await this.api.send(BLE.rx, Array.from(frame), "withoutResponse", BLE.service);
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
