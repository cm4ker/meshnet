/**
 * Lending the radio to a computer, from an iPhone (`MeshRelay.swift`). The
 * phone serves the radio's own Bluetooth service, so a computer nearby
 * connects to the phone as if it were the radio and the phone passes the
 * bytes on, in the background too.
 *
 * The firmware answers one command at a time and does not say whose it was,
 * so the radio has one master: while a computer has it, the page lets go of
 * the radio (the relay keeps the link up), and it takes the radio back when
 * the computer leaves.
 */

import { useSyncExternalStore } from "react";
import type { PluginListenerHandle } from "@capacitor/core";
import { connectorById, lastLink, type FoundDevice } from "../transports/index.js";
import { connectWith, disconnect } from "./link.js";
import { nativePlatform, shell } from "./platform.js";
import { session } from "./session.js";
import { readSetting, writeSetting } from "./storage.js";

interface RelayState {
  on: boolean;
  /** A computer has the radio. */
  computer: boolean;
}

interface MeshRelayPlugin {
  start(options: { deviceId: string; name: string }): Promise<RelayState>;
  stop(): Promise<RelayState>;
  state(): Promise<RelayState>;
  addListener(event: "state", listener: (state: RelayState) => void): Promise<PluginListenerHandle>;
}

const WANTED_KEY = "meshnet.relay.on";

let plugin: MeshRelayPlugin | null = null;
let state: RelayState = { on: false, computer: false };
const listeners = new Set<() => void>();
/** The radio the page let go of for the computer, to connect to again when it leaves. */
let lent: FoundDevice | null = null;

export function relayAvailable(): boolean {
  return shell() === "capacitor" && nativePlatform() === "ios";
}

export function relayWanted(): boolean {
  return readSetting<boolean>(WANTED_KEY, false);
}

function set(next: RelayState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function useRelay(): RelayState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

/**
 * Runs `use` with the plugin. Never resolve a Promise with the plugin itself:
 * the Capacitor proxy answers `then`, and the promise would hang (see notify.ts).
 */
async function withRelay<T>(use: (api: MeshRelayPlugin) => Promise<T>): Promise<T> {
  if (!plugin) {
    const { registerPlugin } = await import("@capacitor/core");
    plugin = registerPlugin<MeshRelayPlugin>("MeshRelay");
  }
  return use(plugin);
}

/** The phone's BLE radio the page is connected to, by the plugin's id. */
function bleRadio(): FoundDevice | null {
  const link = session.getState().link;
  const last = lastLink();
  if (link?.kind !== "ble" || last?.connectorId !== "cap-ble" || !last.device.id) return null;
  return last.device;
}

async function startFor(device: FoundDevice): Promise<void> {
  set(await withRelay((api) => api.start({ deviceId: device.id, name: session.getState().self?.name ?? device.name })));
}

export async function setRelayWanted(on: boolean): Promise<void> {
  writeSetting(WANTED_KEY, on);
  if (on) {
    const device = bleRadio();
    if (device) await startFor(device);
  } else {
    await takeBack();
  }
}

/** Stops lending: the relay stops, and the page connects to the radio again. */
export async function takeBack(): Promise<void> {
  set(await withRelay((api) => api.stop()));
  await reclaim();
}

async function reclaim(): Promise<void> {
  const device = lent;
  lent = null;
  const connector = connectorById("cap-ble");
  if (device && connector) await connectWith(connector, device).catch(() => undefined);
}

async function onState(next: RelayState): Promise<void> {
  const had = state.computer;
  set(next);
  if (next.computer && !had && !lent) {
    const device = bleRadio();
    if (!device) return;
    lent = device;
    await disconnect();
  } else if (!next.computer && had && lent) {
    await reclaim();
  }
}

/** At launch: follows the page's radio while the switch is on. */
export async function startRelay(): Promise<void> {
  if (!relayAvailable()) return;
  await withRelay((api) => api.addListener("state", (next) => void onState(next)));
  set(await withRelay((api) => api.state()));
  let started: string | null = null;
  session.subscribe(() => {
    if (!relayWanted() || session.getState().status !== "ready") return;
    const device = bleRadio();
    if (!device || device.id === started) return;
    started = device.id;
    void startFor(device).catch((error) => console.warn("Could not start the relay", error));
  });
}
