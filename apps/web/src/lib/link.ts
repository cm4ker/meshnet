/**
 * Connecting, and reconnecting: the piece between the connect screen and the
 * session. Keeps which connector and device are in use so a dropped link can
 * be retried without asking, and so the next launch can start where this one
 * left off.
 */

import { useSyncExternalStore } from "react";
import { session } from "./session.js";
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

export async function connectWith(connector: Connector, device: FoundDevice | null): Promise<void> {
  cancelRetry();
  wantedLink = { connector, device };
  set({ phase: "connecting", error: null });
  try {
    const transport = await withTimeout(connector.connect(device), device ? `${device.name}` : connector.title);
    await session.connect(transport);
    rememberLink({ connectorId: connector.id, device: device ?? { id: "", name: transport.label, detail: null, rssi: null } });
    set({ phase: "connected", error: null, retrying: false, attempt: 0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    set({ phase: "failed", error: message });
    throw error;
  }
}

export async function disconnect(): Promise<void> {
  cancelRetry();
  wantedLink = null;
  await session.disconnect();
  set({ phase: "idle", error: null, retrying: false, attempt: 0 });
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
  set({ phase: "connecting", retrying: true, attempt, error: null });
  retryTimer = setTimeout(async () => {
    retryTimer = null;
    const link = wantedLink;
    if (!link) return;
    try {
      const transport = await withTimeout(link.connector.connect(link.device), link.device?.name ?? link.connector.title);
      await session.connect(transport);
      set({ phase: "connected", retrying: false, attempt: 0, error: null });
    } catch (error) {
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
