/**
 * The app's own notice on a phone or in a tab (noticePrefs `shownBy: "app"`):
 * one banner at the top while the app is on screen, in place of the system's.
 * A newer notice replaces the one shown; it goes by itself after a few
 * seconds, when it is swiped away, and when what it said has been read.
 */

import { useSyncExternalStore } from "react";
import type { Notice } from "./announce.js";

export interface Banner {
  id: number;
  notice: Notice;
}

/** How long a banner stays, ms. */
const STAY = 5000;

let current: Banner | null = null;
let next = 1;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function showBanner(notice: Notice): void {
  current = { id: next++, notice };
  if (timer) clearTimeout(timer);
  timer = setTimeout(dismissBanner, STAY);
  emit();
}

export function dismissBanner(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!current) return;
  current = null;
  emit();
}

/** Held while a finger is on it, so it does not leave from under the finger; let go, it stays its full time again. */
export function holdBanner(held: boolean): void {
  if (!current) return;
  if (timer) clearTimeout(timer);
  timer = held ? null : setTimeout(dismissBanner, STAY);
}

/** What the banner said has been read elsewhere. */
export function withdrawBanner(tag: string): void {
  if (current?.notice.tag === tag) dismissBanner();
}

export function getBanner(): Banner | null {
  return current;
}

export function useBanner(): Banner | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getBanner,
  );
}
