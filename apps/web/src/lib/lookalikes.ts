/**
 * Cyrillic letters that look exactly like Latin ones go out as their Latin
 * twins: in UTF-8 the Cyrillic takes two bytes and the Latin one, so a
 * message of 160 bytes carries about a fifth more Russian, and reads the
 * same at the other end. Only pairs that match in every common typeface are
 * swapped; к/k, т/m, п/n and the like look alike in some fonts only.
 */

import { useSyncExternalStore } from "react";
import { readSetting, writeSetting } from "./storage.js";

const EXACT: Record<string, string> = {
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  х: "x",
  і: "i",
  А: "A",
  В: "B",
  Е: "E",
  К: "K",
  М: "M",
  Н: "H",
  О: "O",
  Р: "P",
  С: "C",
  Т: "T",
  Х: "X",
  І: "I",
};

/** The same in most typefaces, not in every one: the Cyrillic у has a straighter tail in some. */
const NEAR: Record<string, string> = { у: "y", У: "Y" };

/** Every letter that may have gone out as a Latin twin, with its twin; a search reads them as one. */
export const TWINS: Readonly<Record<string, string>> = { ...EXACT, ...NEAR };

export interface LookalikePrefs {
  on: boolean;
  /** Also у and У. */
  near: boolean;
}

export function packLookalikes(text: string, prefs: LookalikePrefs): string {
  if (!prefs.on) return text;
  let out = "";
  for (const c of text) out += EXACT[c] ?? (prefs.near ? NEAR[c] : undefined) ?? c;
  return out;
}

const KEY = "meshnet.lookalikes";
let prefs: LookalikePrefs = { on: true, near: false, ...readSetting<Partial<LookalikePrefs>>(KEY, {}) };
const listeners = new Set<() => void>();

export function getLookalikePrefs(): LookalikePrefs {
  return prefs;
}

export function setLookalikePrefs(patch: Partial<LookalikePrefs>): void {
  prefs = { ...prefs, ...patch };
  writeSetting(KEY, prefs);
  for (const listener of listeners) listener();
}

export function useLookalikePrefs(): LookalikePrefs {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => prefs,
  );
}
