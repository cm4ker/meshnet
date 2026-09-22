/**
 * Connecting, and reconnecting: the piece between the connect screen and the
 * session. Keeps which connector and device are in use so a dropped link can
 * be retried without asking, and so the next launch can start where this one
 * left off.
 */

import { useSyncExternalStore } from "react";
import { session } from "./session.js";
import type { Transport } from "@meshnet/meshcore";
import { autoConnectWanted, connectorById, lastLink, rememberLink, type Connector, type FoundDevice } from "../transports/index.js";

export interface LinkState {
  phase: "idle" | "connecting" | "connected" | "failed";
  error: string | null;
  /** Set while a dropped link is being retried. */
  retrying: boolean;
  attempt: number;
}

let state: LinkState = { phase: "idle", error: null, retrying: false, attempt: 0 };
const listeners = new Set<() => void>();
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let wantedLink: { connector: Connector; device: FoundDevice | null } | null = null;
/** Bumped by every connect and disconnect: an attempt from before it is no longer wanted. */
let generation = 0;

function set(patch: Partial<LinkState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function getLink(): LinkState {
  return state;
}

export function useLink(): LinkState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

/** A link that neither opens nor fails within this is reported as failed rather than spun on forever. */
const OPEN_TIMEOUT_MS = 45_000;

function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not answer in ${OPEN_TIMEOUT_MS / 1000} s`)), OPEN_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Opens a link for attempt `gen`. A link that opens after its wait was given
 * up, or after another radio was picked, is closed rather than left holding
 * a radio nobody reads (and, on a phone, reconnected to at the next drop).
 */
async function open(connector: Connector, device: FoundDevice | null, gen: number): Promise<Transport | null> {
  const opening = connector.connect(device);
  let transport: Transport;
  try {
    transport = await withTimeout(opening, device ? device.name : connector.title);
  } catch (error) {
    void opening.then((late) => late.close(), () => undefined);
    throw error;
  }
  if (gen === generation) return transport;
  await transport.close().catch(() => undefined);
  return null;
}

export async function connectWith(connector: Connector, device: FoundDevice | null): Promise<void> {
  cancelRetry();
  const gen = ++generation;
  wantedLink = { connector, device };
  set({ phase: "connecting", error: null });
  try {
    const transport = await open(connector, device, gen);
    if (!transport) return;
    await session.connect(transport);
    if (gen !== generation) return;
    rememberLink({ connectorId: connector.id, device: device ?? { id: "", name: transport.label, detail: null, rssi: null } });
    set({ phase: "connected", error: null, retrying: false, attempt: 0 });
  } catch (error) {
    // Given up for another radio or a disconnect: its failure is no news.
    if (gen !== generation) return;
    const message = error instanceof Error ? error.message : String(error);
    set({ phase: "failed", error: message });
    throw error;
  }
}

export async function disconnect(): Promise<void> {
  cancelRetry();
  generation++;
  wantedLink = null;
  await session.disconnect();
  set({ phase: "idle", error: null, retrying: false, attempt: 0 });
}

/** Stop reconnecting during installation; restore this exact link if installation fails. */
export async function pauseForUpdate(): Promise<() => Promise<void>> {
  const previous = wantedLink;
  const resume = async () => {
    if (previous) {
      // Reconnecting loads history from disk. Never replace unsaved in-memory data with an older copy.
      await session.flush();
      await connectWith(previous.connector, previous.device);
    }
  };
  try {
    await disconnect();
  } catch (error) {
    await resume().catch(() => undefined);
    throw error;
  }
  return resume;
}

function cancelRetry(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

/** On a drop that was not asked for, try again with a growing pause, up to a point. */
session.subscribe(() => {
  const status = session.getState().status;
  if (status !== "closed" || !wantedLink || state.phase !== "connected") return;
  if (!wantedLink.device || wantedLink.connector.mode === "picker") {
    // A chooser cannot be reopened without a click.
    set({ phase: "failed", error: "link dropped" });
    return;
  }
  scheduleRetry();
});

function scheduleRetry(): void {
  const attempt = state.attempt + 1;
  if (attempt > 6) {
    set({ phase: "failed", error: "link dropped and could not be restored", retrying: false });
    return;
  }
  const delay = Math.min(30_000, 1000 * 2 ** (attempt - 1));
  const gen = generation;
  set({ phase: "connecting", retrying: true, attempt, error: null });
  retryTimer = setTimeout(async () => {
    retryTimer = null;
    const link = wantedLink;
    if (!link || gen !== generation) return;
    try {
      const transport = await open(link.connector, link.device, gen);
      if (!transport) return;
      await session.connect(transport);
      if (gen !== generation) return;
      set({ phase: "connected", retrying: false, attempt: 0, error: null });
    } catch (error) {
      if (gen !== generation) return;
      set({ error: error instanceof Error ? error.message : String(error) });
      scheduleRetry();
    }
  }, delay);
}

/** At launch: the last link, if it can be reached without a chooser. */
export async function autoConnect(): Promise<void> {
  if (!autoConnectWanted()) return;
  const last = lastLink();
  if (!last) return;
  const connector = connectorById(last.connectorId);
  if (!connector) return;
  const remembered = await connector.remembered();
  const device =
    remembered.find((d) => d.id === last.device.id) ?? (connector.mode === "scan" && last.device.id ? last.device : null);
  if (!device) return;
  await connectWith(connector, device).catch(() => undefined);
}
