/**
 * Sharing the radio with a computer, from a phone (`MeshRelay.swift` on iOS,
 * `MeshRelay.java` on Android, alike but for the name a computer sees). The
 * phone serves the radio's own Bluetooth service, so a computer nearby
 * connects to the phone as if it were the radio, and uses it through the
 * phone, in the background too.
 *
 * Both use the radio at once: while sharing is on, the page's frames go
 * through the relay as well, and the relay takes turns between the two and
 * keeps each a copy of every message (see `MeshRelayMux.swift` and
 * `RelayMux.java`). The BLE transport opens the relay (`openRelay`) when the
 * switch is on.
 */

import { useSyncExternalStore } from "react";
import type { PluginListenerHandle } from "@capacitor/core";
import { nativePlatform, shell } from "./platform.js";
import { readSetting, writeSetting } from "./storage.js";

interface RelayState {
  on: boolean;
  /** A computer is connected to the phone. */
  computer: boolean;
}

interface MeshRelayPlugin {
  start(options: { deviceId: string; name: string }): Promise<RelayState>;
  stop(): Promise<RelayState>;
  state(): Promise<RelayState>;
  attach(): Promise<void>;
  detach(): Promise<void>;
  send(options: { data: string }): Promise<void>;
  addListener(event: "state", listener: (state: RelayState) => void): Promise<PluginListenerHandle>;
  addListener(event: "frame", listener: (event: { data: string }) => void): Promise<PluginListenerHandle>;
}

const WANTED_KEY = "meshnet.relay.on";

let plugin: MeshRelayPlugin | null = null;
let state: RelayState = { on: false, computer: false };
const listeners = new Set<() => void>();

export function relayAvailable(): boolean {
  const platform = nativePlatform();
  return shell() === "capacitor" && (platform === "ios" || platform === "android");
}

/** Whether the page should reach its BLE radio through the relay. */
export function relayWanted(): boolean {
  return relayAvailable() && readSetting<boolean>(WANTED_KEY, false);
}

export function setRelayWanted(on: boolean): void {
  writeSetting(WANTED_KEY, on);
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

/** The page's link through the relay, while one is open. */
export interface RelayLink {
  send(frame: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

interface Route {
  onFrame: (frame: Uint8Array) => void;
  /** Sharing was turned off: the link through it is gone. */
  onStopped: () => void;
}

let route: Route | null = null;
let listening: Promise<unknown> | null = null;

function listen(): Promise<unknown> {
  listening ??= Promise.all([
    withRelay((api) => api.addListener("frame", (event) => route?.onFrame(fromBase64(event.data)))),
    withRelay((api) =>
      api.addListener("state", (next) => {
        set(next);
        if (!next.on) route?.onStopped();
      }),
    ),
  ]);
  return listening;
}

/** Starts sharing the radio the page has just connected to, and talks to it through the relay. */
export async function openRelay(deviceId: string, name: string, onFrame: Route["onFrame"], onStopped: Route["onStopped"]): Promise<RelayLink> {
  await listen();
  set(await withRelay((api) => api.start({ deviceId, name: name.replace(/^MeshCore-/, "") })));
  const mine: Route = { onFrame, onStopped };
  route = mine;
  await withRelay((api) => api.attach());
  return {
    send: (frame) => withRelay((api) => api.send({ data: toBase64(frame) })),
    async close() {
      if (route !== mine) return;
      route = null;
      await withRelay((api) => api.detach()).catch(() => undefined);
    },
  };
}

/** Stops sharing. The page's link through the relay reports a drop, and is reconnected directly. */
export async function stopRelay(): Promise<void> {
  if (!relayAvailable()) return;
  set(await withRelay((api) => api.stop()));
  route?.onStopped();
}
