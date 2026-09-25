/**
 * Which shell this client is running in. Decided once, from what the window
 * carries: the Tauri shell injects `__TAURI_INTERNALS__`, the Capacitor one
 * `Capacitor` with a native platform, and a browser has neither.
 */

export type Shell = "tauri" | "capacitor" | "browser";

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

function capacitor(): CapacitorGlobal | undefined {
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
}

export function shell(): Shell {
  if ("__TAURI_INTERNALS__" in window) return "tauri";
  const cap = capacitor();
  if (cap?.isNativePlatform?.()) return "capacitor";
  return "browser";
}

export function isTauri(): boolean {
  return shell() === "tauri";
}

export function isCapacitor(): boolean {
  return shell() === "capacitor";
}

/** `"ios"`, `"android"`, or `"web"`, in the phone shell. */
export function nativePlatform(): string {
  return capacitor()?.getPlatform?.() ?? "web";
}

export function hasWebBluetooth(): boolean {
  return shell() === "browser" && "bluetooth" in navigator;
}

export function hasWebSerial(): boolean {
  return shell() === "browser" && "serial" in navigator;
}

/** A pointer that hovers is a mouse; without one, actions cannot hide behind hover. */
export function canHover(): boolean {
  return window.matchMedia("(hover: hover)").matches;
}

/** A finger is the main pointer: typing is on a screen keyboard, with no Shift to hold. */
export function touchFirst(): boolean {
  return window.matchMedia("(pointer: coarse)").matches;
}
