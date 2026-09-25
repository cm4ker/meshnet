import { useSyncExternalStore } from "react";
import { readSetting, writeSetting } from "./storage.js";

/**
 * Where a chat opens: at its first unread message, or at its latest one.
 *
 * The session marks a chat read the moment it comes on screen, before its view
 * draws, so the count is noted here first and the view takes it on opening.
 */

const KEY = "meshnet.openAtUnread";
let openAtUnread = readSetting<boolean>(KEY, true);
const listeners = new Set<() => void>();

export function setOpenAtUnread(on: boolean): void {
  openAtUnread = on;
  writeSetting(KEY, on);
  for (const listener of listeners) listener();
}

export function getOpenAtUnread(): boolean {
  return openAtUnread;
}

export function useOpenAtUnread(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => openAtUnread,
  );
}

let noted: { conversation: string; count: number } | null = null;

/** The conversation on screen, with the unread count it had; called just before the session reads it. */
export function noteUnread(conversation: string | null, count: number): void {
  noted = conversation ? { conversation, count } : null;
}

/** How many were unread when the conversation came on screen; taken once, by the view that opens it. */
export function takeUnread(conversation: string): number {
  if (noted?.conversation !== conversation) return 0;
  const { count } = noted;
  noted = null;
  return count;
}
