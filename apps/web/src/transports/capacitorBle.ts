/**
 * BLE on a phone, through the Capacitor plugin. The plugin scans, connects,
 * and on Android asks for a 512-byte MTU by itself, which the 176-byte frames
 * need; iOS negotiates the largest MTU on its own.
 */

import { BaseTransport, BLE } from "@meshnet/meshcore";
import type { Connector, FoundDevice } from "./types.js";
import { unwatchRadio, watchRadio } from "../lib/notify.js";
import { nativePlatform } from "../lib/platform.js";
import { readSetting, writeSetting } from "../lib/storage.js";

type BleModule = typeof import("@capacitor-community/bluetooth-le");

let plugin: Promise<BleModule> | null = null;
let initialised = false;

async function ble(): Promise<BleModule["BleClient"]> {
  plugin ??= import("@capacitor-community/bluetooth-le");
  const mod = await plugin;
  if (!initialised) {
    await mod.BleClient.initialize({ androidNeverForLocation: true });
    initialised = true;
  }
  return mod.BleClient;
}

class CapacitorBleTransport extends BaseTransport {
  readonly kind = "ble" as const;

  constructor(
    private readonly client: BleModule["BleClient"],
    private readonly deviceId: string,
    readonly label: string,
  ) {
    super();
  }

  async send(frame: Uint8Array): Promise<void> {
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    // With response: the characteristic demands an encrypted link, and an
    // acknowledged write is what makes the phone start the PIN pairing on an
    // unpaired one instead of dropping the bytes.
    await this.client.write(this.deviceId, BLE.service, BLE.rx, view);
  }

  receive(value: DataView): void {
    if (value.byteLength === 0) return;
    this.emitFrame(new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)));
  }

  onDropped(): void {
    this.emitClose(new Error("Bluetooth device disconnected"));
  }

  protected async shutdown(): Promise<void> {
    void unwatchRadio(this.deviceId);
    try {
      await this.client.stopNotifications(this.deviceId, BLE.service, BLE.tx);
    } catch {
      // Already gone.
    }
    try {
      await this.client.disconnect(this.deviceId);
    } catch {
      // Already gone.
    }
  }
}

const SCAN_MS = 10_000;

/** Radios connected to before, by the id the phone gave them, so they can be reached without a scan. */
const KNOWN_KEY = "meshnet.ble.known";

function known(): FoundDevice[] {
  return readSetting<FoundDevice[]>(KNOWN_KEY, []);
}

function remember(device: FoundDevice): void {
  writeSetting(KNOWN_KEY, [device, ...known().filter((d) => d.id !== device.id)].slice(0, 8));
}

export const capacitorBleConnector: Connector = {
  id: "cap-ble",
  kind: "ble",
  title: "Bluetooth",
  description: "Radios in range.",
  mode: "scan",

  async scan(onFound, signal) {
    const client = await ble();
    const seen = new Map<string, FoundDevice>();
    // A radio already connected to this phone, by another app or by the
    // system, stops advertising, and iOS leaves it out of every scan. iOS
    // hands those over by service instead. Android's list is every GATT
    // connection, watches and headphones included, so it is not asked.
    const connected = nativePlatform() === "ios" ? await client.getConnectedDevices([BLE.service]).catch(() => []) : [];
    for (const device of connected) {
      seen.set(device.deviceId, { id: device.deviceId, name: device.name ?? "MeshCore", detail: "connected to this phone", rssi: null });
    }
    if (seen.size > 0) onFound([...seen.values()]);
    if (signal.aborted) return;
    await client.requestLEScan({ services: [BLE.service], allowDuplicates: false }, (result) => {
      seen.set(result.device.deviceId, {
        id: result.device.deviceId,
        name: result.localName ?? result.device.name ?? "MeshCore",
        detail: null,
        rssi: result.rssi ?? null,
      });
      onFound([...seen.values()]);
    });
    // The plugin scans until told to stop and resolves as soon as it starts.
    // This one stops after a while, and resolves then, so the screen can tell
    // "still looking" from "nothing found".
    await new Promise<void>((resolve) => {
      const stop = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        void client.stopLEScan().catch(() => undefined).finally(resolve);
      };
      const timer = setTimeout(stop, SCAN_MS);
      signal.addEventListener("abort", stop, { once: true });
    });
  },

  async remembered() {
    return known();
  },

  async connect(device) {
    if (!device) throw new Error("pick a radio from the list");
    const client = await ble();
    // iOS connects only to a peripheral the plugin has met since launch. A
    // remembered radio, or the one "Reconnect at launch" reaches for, is met
    // by asking the system for it by id.
    await client.getDevices([device.id]).catch(() => []);
    let transport: CapacitorBleTransport | null = null;
    await client.connect(device.id, () => transport?.onDropped());
    transport = new CapacitorBleTransport(client, device.id, device.name);
    try {
      await client.startNotifications(device.id, BLE.service, BLE.tx, (value) => transport?.receive(value));
    } catch (error) {
      // A radio left connected after a failed attempt (a PIN prompt turned
      // down or left to time out) stays taken, and its prompt can come back.
      await client.disconnect(device.id).catch(() => undefined);
      throw error;
    }
    remember(device);
    void watchRadio(device.id);
    return transport;
  },
};
