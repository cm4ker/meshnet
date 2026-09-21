import type { Transport, TransportKind } from "@meshnet/meshcore";

/** A radio the connect screen can offer. */
export interface FoundDevice {
  /** What `connect` takes: a BLE address, a serial path, a browser device id. */
  id: string;
  name: string;
  /** A second line: an address, a manufacturer, a signal. */
  detail: string | null;
  rssi: number | null;
}

/**
 * One way of reaching a radio on this platform. `picker` connectors hand the
 * choice to the browser's own chooser (Web Bluetooth, Web Serial); `scan`
 * connectors list what they find and connect to one.
 */
export interface Connector {
  id: string;
  kind: TransportKind;
  title: string;
  description: string;
  mode: "picker" | "scan";
  /** Lists devices as they are found until the signal aborts. `scan` connectors only. */
  scan?(onFound: (devices: FoundDevice[]) => void, signal: AbortSignal): Promise<void>;
  /** Devices this platform can reconnect to without a scan or a chooser. */
  remembered(): Promise<FoundDevice[]>;
  /** `null` asks the picker; a device connects to it. */
  connect(device: FoundDevice | null): Promise<Transport>;
}

export interface RememberedLink {
  connectorId: string;
  device: FoundDevice;
}
