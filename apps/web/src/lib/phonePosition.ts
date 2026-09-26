/**
 * Where the phone is (#34). The phone app asks the phone's own location
 * service through @capacitor/geolocation: the page's `navigator.geolocation`
 * would do on Android, but on iOS WebKit puts its own "localhost would like
 * to use your location" over the system's question. A browser, and the
 * desktop's one-off button, ask the page's.
 *
 * Nothing asks until a button needs it: the map's "where am I", the one-off
 * "use this device's position", or turning on "follow the phone". Only
 * `locateOnce` shows the system's question; a watch runs on a permission
 * already given, while something holds it and the page is in front.
 */

import { useEffect, useSyncExternalStore } from "react";
import { t } from "../i18n/index.js";
import { isCapacitor, shell } from "./platform.js";

export interface Fix {
  lat: number;
  lon: number;
  /** Metres either way the phone may be. */
  accuracy: number;
  at: number;
}

export type LocateProblem = "denied" | "off" | "timeout" | "unavailable";

export class LocateError extends Error {
  constructor(readonly problem: LocateProblem) {
    super(`phone position: ${problem}`);
    this.name = "LocateError";
  }
}

/** Why the phone could not say where it is, and what the reader can do about it. */
export function locateText(error: unknown): string {
  const problem = error instanceof LocateError ? error.problem : "unavailable";
  if (problem === "denied") return t("radio.locate.denied");
  if (problem === "off") return t("radio.locate.off");
  if (problem === "timeout") return t("radio.locate.timeout");
  return t("radio.name.noPosition");
}

/** A first fix with no network, GPS alone, can take most of a minute; a mesh is often used with none. */
const FIX_TIMEOUT_MS = 60_000;

/** The map's "where am I" and following the phone: the phone app, and the browser demo to try them in. */
export function phoneLocates(): boolean {
  return isCapacitor() || (shell() === "browser" && "geolocation" in navigator);
}

/** The one-off button: anywhere that can say where it is, the desktop too. */
export function canLocate(): boolean {
  return isCapacitor() || "geolocation" in navigator;
}

// ---- the phone app's location service ----

type Permission = "prompt" | "prompt-with-rationale" | "granted" | "denied";
interface NativePosition {
  timestamp: number;
  coords: { latitude: number; longitude: number; accuracy: number };
}
interface NativeOptions {
  enableHighAccuracy?: boolean;
  timeout?: number;
  maximumAge?: number;
}
interface GeolocationPlugin {
  checkPermissions(): Promise<{ location: Permission; coarseLocation: Permission }>;
  requestPermissions(): Promise<{ location: Permission; coarseLocation: Permission }>;
  getCurrentPosition(options?: NativeOptions): Promise<NativePosition>;
  watchPosition(options: NativeOptions, callback: (position: NativePosition | null, error?: unknown) => void): Promise<string>;
  clearWatch(options: { id: string }): Promise<void>;
}

let native: Promise<GeolocationPlugin> | null = null;
function plugin(): Promise<GeolocationPlugin> {
  native ??= import("@capacitor/core").then(({ registerPlugin }) => registerPlugin<GeolocationPlugin>("Geolocation"));
  return native;
}

/** The plugin's error codes (OS-PLUG-GLOC-00NN), by what the reader can do about them. */
function nativeProblem(error: unknown): LocateError {
  if (error instanceof LocateError) return error;
  const code = Number(/OS-PLUG-GLOC-(\d+)/.exec(String((error as { code?: unknown })?.code ?? ""))?.[1]);
  if (code === 3 || code === 8) return new LocateError("denied");
  if (code === 7 || code === 9 || code === 16 || code === 17) return new LocateError("off");
  if (code === 10) return new LocateError("timeout");
  return new LocateError("unavailable");
}

function webProblem(error: GeolocationPositionError): LocateError {
  return new LocateError(error.code === error.PERMISSION_DENIED ? "denied" : error.code === error.TIMEOUT ? "timeout" : "unavailable");
}

function fixOf(position: { timestamp: number; coords: { latitude: number; longitude: number; accuracy: number } }): Fix {
  return { lat: position.coords.latitude, lon: position.coords.longitude, accuracy: position.coords.accuracy, at: position.timestamp || Date.now() };
}

type Status = { location: Permission; coarseLocation: Permission };
const granted = (status: Status) => status.location === "granted" || status.coarseLocation === "granted";
/** Denied once for good, the system shows no question again; the reader gives leave in the phone's settings. */
const askable = (status: Status) => [status.location, status.coarseLocation].some((p) => p === "prompt" || p === "prompt-with-rationale");

/** Leave to use the phone's position: asked of the reader only when `ask`, and only if it can still be asked. */
async function allowed(geo: GeolocationPlugin, ask: boolean): Promise<void> {
  let status;
  try {
    status = await geo.checkPermissions();
  } catch (error) {
    // iOS answers "location services are off" here rather than a state.
    throw nativeProblem(error);
  }
  if (granted(status)) return;
  if (!ask || !askable(status)) throw new LocateError("denied");
  try {
    status = await geo.requestPermissions();
  } catch (error) {
    throw nativeProblem(error);
  }
  if (!granted(status)) throw new LocateError("denied");
}

// ---- what the app knows of the phone's position ----

export interface PhoneState {
  /** The latest fix, from a one-off ask or a watch. */
  fix: Fix | null;
  /** Why the last ask or the watch came to nothing. */
  problem: LocateProblem | null;
}

let state: PhoneState = { fix: null, problem: null };
const listeners = new Set<() => void>();

function set(patch: Partial<PhoneState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function getPhoneState(): PhoneState {
  return state;
}

export function subscribePhone(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Where the phone is now, asking the reader for leave if it was never given. */
export async function locateOnce(): Promise<Fix> {
  const options = { enableHighAccuracy: true, timeout: FIX_TIMEOUT_MS, maximumAge: 10_000 };
  try {
    let fix: Fix;
    if (isCapacitor()) {
      const geo = await plugin();
      await allowed(geo, true);
      try {
        fix = fixOf(await geo.getCurrentPosition(options));
      } catch (error) {
        throw nativeProblem(error);
      }
    } else {
      if (!("geolocation" in navigator)) throw new LocateError("unavailable");
      fix = await new Promise<Fix>((resolve, reject) => navigator.geolocation.getCurrentPosition((p) => resolve(fixOf(p)), (e) => reject(webProblem(e)), options));
    }
    set({ fix, problem: null });
    return fix;
  } catch (error) {
    const problem = error instanceof LocateError ? error : new LocateError("unavailable");
    set({ problem: problem.problem });
    throw problem;
  }
}

/** Follows the phone until the returned function is called; never asks the reader. */
async function startWatch(onFix: (fix: Fix) => void, onProblem: (problem: LocateProblem) => void): Promise<() => void> {
  const options = { enableHighAccuracy: true, timeout: FIX_TIMEOUT_MS, maximumAge: 10_000 };
  if (isCapacitor()) {
    const geo = await plugin();
    await allowed(geo, false);
    const id = await geo.watchPosition(options, (position, error) => (position ? onFix(fixOf(position)) : onProblem(nativeProblem(error).problem)));
    return () => void geo.clearWatch({ id }).catch(() => undefined);
  }
  if (!("geolocation" in navigator)) throw new LocateError("unavailable");
  const id = navigator.geolocation.watchPosition((p) => onFix(fixOf(p)), (e) => onProblem(webProblem(e).problem), options);
  return () => navigator.geolocation.clearWatch(id);
}

let holds = 0;
let stop: (() => void) | null = null;
let hooked = false;

function run(): void {
  if (stop || holds === 0 || document.visibilityState === "hidden") return;
  let stopped = false;
  let clear: (() => void) | null = null;
  stop = () => {
    stopped = true;
    clear?.();
    stop = null;
  };
  const lost = (problem: LocateProblem) => {
    if (stopped) return;
    set({ problem });
    // Leave taken away: nothing more comes until it is given back and asked for again.
    if (problem === "denied") stop?.();
  };
  startWatch((fix) => !stopped && set({ fix, problem: null }), lost).then(
    (end) => (stopped ? end() : (clear = end)),
    (error: unknown) => lost(error instanceof LocateError ? error.problem : "unavailable"),
  );
}

/**
 * Keeps the phone's position coming until the returned function is called.
 * The watch pauses while the page is hidden: a phone's page sleeps there
 * anyway, and the location service need not keep the GPS on for it.
 */
export function holdPhone(): () => void {
  if (!hooked) {
    hooked = true;
    document.addEventListener("visibilitychange", () => (document.visibilityState === "hidden" ? stop?.() : run()));
  }
  holds++;
  run();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds--;
    if (holds === 0) stop?.();
  };
}

/** The phone's position, kept coming while `active`. */
export function usePhone(active: boolean): PhoneState {
  useEffect(() => (active ? holdPhone() : undefined), [active]);
  return useSyncExternalStore(subscribePhone, getPhoneState);
}
