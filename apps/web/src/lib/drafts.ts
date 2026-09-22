/**
 * What was typed and not sent, one per conversation of each radio: it
 * outlives leaving the chat and restarting the app, and the chat list shows
 * it in place of the last message.
 */

import { useSyncExternalStore } from "react";
import { readSetting, writeSetting } from "./storage.js";

const KEY = "meshnet.drafts";
let drafts: Record<string, string> = readSetting<Record<string, string>>(KEY, {});
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** A channel's index names a different channel on another radio, so the radio is part of the slot. */
const slot = (radio: string, conversation: string) => `${radio}/${conversation}`;

function save(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  writeSetting(KEY, drafts);
}

// A keystroke need not reach the disk at once; leaving the page must.
if (typeof window !== "undefined") window.addEventListener("pagehide", () => saveTimer && save());

export function getDraft(radio: string, conversation: string): string {
  return drafts[slot(radio, conversation)] ?? "";
}

export function setDraft(radio: string, conversation: string, text: string): void {
  const key = slot(radio, conversation);
  const next = text.trim() ? text : "";
  if ((drafts[key] ?? "") === next) return;
  drafts = { ...drafts };
  if (next) drafts[key] = next;
  else delete drafts[key];
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
  for (const listener of listeners) listener();
}

export function useDraft(radio: string, conversation: string): string {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getDraft(radio, conversation),
  );
}
