/**
 * Where the client is: which section, and which conversation or contact is
 * open in it. One small store, so the phone's tab bar and the desktop's rail
 * read the same thing.
 */

import { useSyncExternalStore } from "react";
import { readSetting, writeSetting } from "./storage.js";

export type Section = "chats" | "contacts" | "map" | "nodes" | "radio" | "log" | "settings";

export interface Nav {
  section: Section;
  /** The conversation open in Chats, if any. */
  conversation: string | null;
  /** The contact open in Contacts, if any. */
  contact: string | null;
  /** The repeater, room or sensor open in Nodes, if any. */
  node: string | null;
}

const KEY = "meshnet.nav";
// Partial: a nav saved before Nodes existed has no `node`.
let nav: Nav = { section: "chats", conversation: null, contact: null, node: null, ...readSetting<Partial<Nav>>(KEY, {}) };
const listeners = new Set<() => void>();

function set(patch: Partial<Nav>): void {
  nav = { ...nav, ...patch };
  writeSetting(KEY, nav);
  for (const listener of listeners) listener();
}

export function getNav(): Nav {
  return nav;
}

export function goSection(section: Section): void {
  set({ section });
}

export function openConversation(conversation: string | null): void {
  set({ section: "chats", conversation });
}

export function openContact(contact: string | null): void {
  set({ section: "contacts", contact });
}

export function openNode(node: string | null): void {
  set({ section: "nodes", node });
}

export function useNav(): Nav {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => nav,
  );
}
