/**
 * Connecting, and reconnecting: the piece between the connect screen and the
 * session. Keeps which connector and device are in use so a dropped link can
 * be retried without asking, and so the next launch can start where this one
 * left off.
 */

import { useSyncExternalStore } from "react";
import { session } from "./session.js";
import type { Transport } from "@meshnet/meshcore";
import { autoConnectWanted, connectorById, lastLink, needsPairing, rememberLink, type Connector, type FoundDevice } from "../transports/index.js";

export interface LinkState {
  phase: "idle" | "connecting" | "connected" | "failed";
  error: string | null;
  /** Set while a dropped link is being retried. */
  retrying: boolean;
  /** Which try this is, while a link is being retried or a picked radio tried again; 0 otherwise. */
  attempt: number;
  /** The last try failed for want of a bond, and the connector can make one with a PIN (`pairLink`). */
  pair: boolean;
  /** A dropped link waits for its next try; `reconnectNow` brings it forward. */
  waiting: boolean;
}

let state: LinkState = { phase: "idle", error: null, retrying: false, attempt: 0, pair: false, waiting: false };
const listeners = new Set<() => void>();
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let wantedLink: { connector: Connector; device: FoundDevice | null } | null = null;
/** Bumped by every connect and disconnect: an attempt from before it is no longer wanted. */
let generation = 0;

function set(patch: Partial<LinkState>): void {
  state = { ...state, pair: false, waiting: false, ...patch };
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

/** How many times a radio picked by hand is tried before the failure is shown: a weak one often times out once. */
export const CONNECT_TRIES = 3;

export async function connectWith(connector: Connector, device: FoundDevice | null): Promise<void> {
  cancelRetry();
  const gen = ++generation;
  wantedLink = { connector, device };
  // A chooser cannot be reopened without a click, and a radio that wants a PIN will not stop wanting it.
  const tries = device && connector.mode !== "picker" ? CONNECT_TRIES : 1;
  for (let attempt = 1; ; attempt++) {
    set({ phase: "connecting", error: null, retrying: false, attempt: tries > 1 ? attempt : 0 });
    try {
      const transport = await open(connector, device, gen);
      if (!transport) return;
      await session.connect(transport);
      if (gen !== generation) return;
      rememberLink({ connectorId: connector.id, device: device ?? { id: "", name: transport.label, detail: null, rssi: null } });
      set({ phase: "connected", error: null, retrying: false, attempt: 0 });
      return;
    } catch (error) {
      // Given up for another radio or a disconnect: its failure is no news.
      if (gen !== generation) return;
      if (attempt < tries && !needsPairing(error)) continue;
      const message = error instanceof Error ? error.message : String(error);
      set({ phase: "failed", error: message, attempt: 0, pair: canPair(connector, device, error) });
      throw error;
    }
  }
}

function canPair(connector: Connector, device: FoundDevice | null, error: unknown): boolean {
  return Boolean(device && connector.pair && needsPairing(error));
}

/**
 * Bonds with the radio the last try wanted, with the PIN on its screen (for
 * a phone sharing its radio, any digits: the phone asks on its own screen),
 * and connects again. Throws when the pairing fails, for the PIN prompt.
 */
export async function pairLink(pin: string): Promise<void> {
  const link = wantedLink;
  if (!link?.device || !link.connector.pair) throw new Error("nothing to pair with");
  await link.connector.pair(link.device, pin);
  void connectWith(link.connector, link.device).catch(() => undefined);
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

/**
 * On a drop that was not asked for, try again with a growing pause, for as
 * long as it takes: a radio out of range or switched off comes back on its
 * own time, and the app is left running to be there when it does.
 */
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

/** The longest pause between two tries. */
const RETRY_MAX_MS = 30_000;

function scheduleRetry(): void {
  const attempt = state.attempt + 1;
  const delay = Math.min(RETRY_MAX_MS, 1000 * 2 ** (attempt - 1));
  const gen = generation;
  set({ phase: "connecting", retrying: true, attempt, error: null, waiting: true });
  retryTimer = setTimeout(() => void retry(gen), delay);
}

async function retry(gen: number): Promise<void> {
  retryTimer = null;
  const link = wantedLink;
  if (!link || gen !== generation) return;
  set({ waiting: false });
  try {
    const transport = await open(link.connector, link.device, gen);
    if (!transport) return;
    await session.connect(transport);
    if (gen !== generation) return;
    set({ phase: "connected", retrying: false, attempt: 0, error: null });
  } catch (error) {
    if (gen !== generation) return;
    const message = error instanceof Error ? error.message : String(error);
    if (canPair(link.connector, link.device, error)) {
      // A radio that wants a bond will not stop wanting it: ask for the PIN instead of trying again.
      set({ phase: "failed", error: message, retrying: false, attempt: 0, pair: true });
      return;
    }
    set({ error: message });
    scheduleRetry();
  }
}

/**
 * Tries the dropped link at once: the next try, brought forward, or the link
 * that failed, again. A try already under way is left to finish.
 */
export function reconnectNow(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    void retry(generation);
  } else if (state.phase === "failed" && wantedLink) {
    void connectWith(wantedLink.connector, wantedLink.device).catch(() => undefined);
  }
}

// Back on screen (the window out of the tray, a phone unlocked), the next try goes at once.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && retryTimer) reconnectNow();
  });
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
