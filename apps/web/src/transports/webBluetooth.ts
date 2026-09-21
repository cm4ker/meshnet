/**
 * Web Bluetooth, for a browser tab: Chrome and Edge on the desktop and on
 * Android. The chooser is the browser's; the page cannot list devices itself.
 */

import { BaseTransport, BLE } from "@meshnet/meshcore";
import type { Connector, FoundDevice } from "./types.js";

class WebBluetoothTransport extends BaseTransport {
  readonly kind = "ble" as const;
  readonly label: string;
  private writeWithResponse = false;

  constructor(
    private readonly device: BluetoothDevice,
    private readonly rx: BluetoothRemoteGATTCharacteristic,
    private readonly tx: BluetoothRemoteGATTCharacteristic,
  ) {
    super();
    this.label = device.name ?? "MeshCore";
    tx.addEventListener("characteristicvaluechanged", this.onValue);
    device.addEventListener("gattserverdisconnected", this.onDisconnected);
  }

  private onValue = (event: Event): void => {
    const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
    if (!value || value.byteLength === 0) return;
    this.emitFrame(new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)));
  };

  private onDisconnected = (): void => {
    this.emitClose(new Error("Bluetooth device disconnected"));
  };

  async send(frame: Uint8Array): Promise<void> {
    // A copy on a plain ArrayBuffer: the API refuses a view that might sit on a shared one.
    const bytes = new Uint8Array(frame);
    if (this.writeWithResponse) {
      await this.rx.writeValueWithResponse(bytes);
      return;
    }
    try {
      await this.rx.writeValueWithoutResponse(bytes);
    } catch (error) {
      // Some stacks reject the unacknowledged write; the acknowledged one is slower and always there.
      if (error instanceof DOMException && error.name === "NotSupportedError") {
        this.writeWithResponse = true;
        await this.rx.writeValueWithResponse(bytes);
        return;
      }
      throw error;
    }
  }

  protected async shutdown(): Promise<void> {
    this.tx.removeEventListener("characteristicvaluechanged", this.onValue);
    this.device.removeEventListener("gattserverdisconnected", this.onDisconnected);
    try {
      await this.tx.stopNotifications();
    } catch {
      // Already gone.
    }
    this.device.gatt?.disconnect();
  }
}

async function attach(device: BluetoothDevice): Promise<WebBluetoothTransport> {
  const gatt = device.gatt;
  if (!gatt) throw new Error("this device has no GATT server");
  const server = await gatt.connect();
  const service = await server.getPrimaryService(BLE.service);
  const rx = await service.getCharacteristic(BLE.rx);
  const tx = await service.getCharacteristic(BLE.tx);
  await tx.startNotifications();
  return new WebBluetoothTransport(device, rx, tx);
}

function found(device: BluetoothDevice): FoundDevice {
  return { id: device.id, name: device.name ?? "MeshCore", detail: null, rssi: null };
}

export const webBluetoothConnector: Connector = {
  id: "web-ble",
  kind: "ble",
  title: "Bluetooth",
  description: "The browser's device chooser.",
  mode: "picker",

  async remembered() {
    // Only where the permission is kept between visits (Chrome behind a flag, Edge).
    if (typeof navigator.bluetooth.getDevices !== "function") return [];
    try {
      const devices = await navigator.bluetooth.getDevices();
      return devices.map(found);
    } catch {
      return [];
    }
  },

  async connect(device) {
    if (device && typeof navigator.bluetooth.getDevices === "function") {
      const known = (await navigator.bluetooth.getDevices()).find((d) => d.id === device.id);
      if (known) return attach(known);
    }
    const chosen = await navigator.bluetooth.requestDevice({
      filters: [{ services: [BLE.service] }, { namePrefix: BLE.namePrefix }],
      optionalServices: [BLE.service],
    });
    return attach(chosen);
  },
};
