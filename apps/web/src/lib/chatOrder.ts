import { useSyncExternalStore } from "react";
import type { ConversationSummary } from "./conversations.js";
import { readSetting, writeSetting } from "./storage.js";

/**
 * How the chat list is ordered, and whether the channels keep a group of
 * their own above the direct chats. Kept on this device, like the theme.
 */

export type ChatOrder = "latest" | "name" | "unread";

export const CHAT_ORDERS: readonly { id: ChatOrder; label: string; short: string }[] = [
  { id: "latest", label: "Latest message", short: "Latest" },
  { id: "name", label: "Name", short: "Name" },
  { id: "unread", label: "Unread first", short: "Unread first" },
];

export interface ChatOrderPrefs {
  order: ChatOrder;
  /** Channels in a group of their own, above the direct chats. */
  channelsFirst: boolean;
}

const KEY = "meshnet.chatOrder";

function read(): ChatOrderPrefs {
  const saved = readSetting<Partial<ChatOrderPrefs> | null>(KEY, null);
  const order = CHAT_ORDERS.find((o) => o.id === saved?.order)?.id ?? "latest";
  return { order, channelsFirst: saved?.channelsFirst === true };
}

let prefs = read();
const listeners = new Set<() => void>();

export function setChatOrder(patch: Partial<ChatOrderPrefs>): void {
  prefs = { ...prefs, ...patch };
  writeSetting(KEY, prefs);
  for (const listener of listeners) listener();
}

export function getChatOrder(): ChatOrderPrefs {
  return prefs;
}

export function useChatOrder(): ChatOrderPrefs {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => prefs,
  );
}

/** Whether the list is ordered other than the usual way, which the sort button shows in the accent. */
export function changed(p: ChatOrderPrefs): boolean {
  return p.order !== "latest" || p.channelsFirst;
}

type Row = ConversationSummary;

/** The newest first; channels nobody has spoken on last, in the order of their slots. */
const byLatest = (a: Row, b: Row) => {
  if (a.lastAt !== b.lastAt) return b.lastAt - a.lastAt;
  if (a.channel && b.channel) return a.channel.index - b.channel.index;
  return a.title.localeCompare(b.title);
};

/** A channel's "#" is not part of its name for the alphabet: #omsk stands with the O's. */
const bare = (title: string) => title.replace(/^#+/, "");
const byName = (a: Row, b: Row) => bare(a.title).localeCompare(bare(b.title), undefined, { sensitivity: "base" }) || byLatest(a, b);
const byUnread = (a: Row, b: Row) => Number(b.unread > 0) - Number(a.unread > 0) || byLatest(a, b);

export function chatComparator(order: ChatOrder): (a: Row, b: Row) => number {
  return order === "name" ? byName : order === "unread" ? byUnread : byLatest;
}

export interface ChatGroup {
  title: string;
  rows: Row[];
}

/**
 * The list's groups, each in the order: the channels, then the direct chats;
 * or, with channels not first, one list. A lone group goes without a title.
 */
export function chatGroups(rows: Row[], p: ChatOrderPrefs): ChatGroup[] {
  const sorted = [...rows].sort(chatComparator(p.order));
  if (!p.channelsFirst) return [{ title: "", rows: sorted }];
  const groups = [
    { title: "Channels", rows: sorted.filter((r) => r.kind === "channel") },
    { title: "Direct", rows: sorted.filter((r) => r.kind !== "channel") },
  ].filter((g) => g.rows.length > 0);
  return groups.length === 1 ? [{ title: "", rows: groups[0]!.rows }] : groups;
}

/** The rows as the list shows them, top to bottom, for stepping through them from the keyboard. */
export function chatsInOrder(rows: Row[], p: ChatOrderPrefs): Row[] {
  return chatGroups(rows, p).flatMap((g) => g.rows);
}
