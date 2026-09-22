import { isCapacitor, nativePlatform } from "../lib/platform.js";

/**
 * How big the text is, as a share of the sizes the stylesheet names: one of
 * a few steps, or whatever the phone's own text size setting asks for. The
 * share lands on the root as `--text-scale`, and every text size in the
 * stylesheet is drawn from it.
 */

const KEY = "meshnet.textSize";
/** The phone's share as last read, so the app opens at it before the shell has answered again. */
const SYSTEM_KEY = "meshnet.textSize.system";

/** The steps offered, smallest to largest. Past the largest the layout stops holding together. */
export const TEXT_STEPS = [0.9, 1, 1.15, 1.3, 1.5] as const;

/** `"system"` to follow the phone, or a step as a string: `"1.15"`. */
export type TextSizePreference = string;

/** A body the size of iOS's own at its default setting, where the share is 1. */
const IOS_BODY = 17;

interface SystemTextPlugin {
  scale(): Promise<{ scale: number }>;
}

const listeners = new Set<() => void>();
let plugin: SystemTextPlugin | null = null;
let preference: TextSizePreference = read(KEY) ?? "system";
let system = clamp(Number(read(SYSTEM_KEY) ?? 1));

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function clamp(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.min(Math.max(...TEXT_STEPS), Math.max(Math.min(...TEXT_STEPS), Math.round(scale * 100) / 100));
}

/** Whether this shell can tell what the system's text size is. A desktop and a browser tab cannot. */
export function hasSystemTextSize(): boolean {
  return isCapacitor() && (nativePlatform() === "ios" || nativePlatform() === "android");
}

export function getTextSizePreference(): TextSizePreference {
  return preference;
}

export function getSystemTextScale(): number {
  return system;
}

/** The share the text is drawn at now. */
export function getTextScale(): number {
  return preference === "system" ? system : clamp(Number(preference));
}

export function subscribeTextSize(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setTextSizePreference(next: TextSizePreference): void {
  preference = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Private window.
  }
  apply();
}

function apply(): void {
  document.documentElement.style.setProperty("--text-scale", String(getTextScale()));
  for (const listener of listeners) listener();
}

/**
 * iOS gives a page its Dynamic Type size through the `-apple-system-body`
 * font; Android gives it nothing, so the app's own plugin reads the display
 * setting's font scale.
 */
async function readSystem(): Promise<number | null> {
  if (!hasSystemTextSize()) return null;
  if (nativePlatform() === "ios") {
    const probe = document.createElement("span");
    probe.style.font = "-apple-system-body";
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    document.body.append(probe);
    const size = parseFloat(getComputedStyle(probe).fontSize);
    probe.remove();
    return size > 0 ? size / IOS_BODY : null;
  }
  const { registerPlugin } = await import("@capacitor/core");
  plugin ??= registerPlugin<SystemTextPlugin>("SystemText");
  return (await plugin.scale()).scale;
}

async function refreshSystem(): Promise<void> {
  let next: number | null;
  try {
    next = await readSystem();
  } catch {
    return;
  }
  if (next === null || clamp(next) === system) return;
  system = clamp(next);
  try {
    localStorage.setItem(SYSTEM_KEY, String(system));
  } catch {
    // Private window.
  }
  apply();
}

/**
 * Before the first render, at the size last used. The phone's setting is read
 * again then, and each time the app comes back to the front, since it can
 * only have changed while the app was away.
 */
export function initTextSize(): void {
  apply();
  if (!hasSystemTextSize()) return;
  void refreshSystem();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refreshSystem();
  });
}
