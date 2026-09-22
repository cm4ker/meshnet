/**
 * Which messages become notices, and how many notices they become.
 *
 * Only a message the radio hands over while the app runs is news: the
 * history read back from the storage at connect was announced on the run
 * that received it. News is read on arrival when its conversation is on
 * screen (the session's focus), and a notice is only ever about unread
 * messages:
 *
 * - a conversation has one notice at most, which says how many are unread
 *   and shows the latest of them, is replaced as more arrive, and is
 *   withdrawn once the conversation is read, wherever it is read;
 * - the radio hands its queue over in a burst, at connect and whenever it
 *   says messages are waiting, and a burst is announced once it is drained,
 *   not message by message;
 * - when more than three conversations would each have a notice, one
 *   notice stands for them all, until the app is opened or all is read.
 *
 * Pure apart from what it is handed, so the rules are testable without a
 * radio or a notification centre.
 */

import type { MessageRecord, SessionState } from "@meshnet/meshcore";
import { titleOf } from "./conversations.js";

export interface Notice {
  title: string;
  body: string;
  tag: string;
}

/** At most this many conversations each have a notice of their own. */
const SEPARATE = 3;
/** How many of a conversation's unread messages its notice shows. */
const LINES = 3;
/** How many conversations the notice for several of them names. */
const NAMED = 4;

/** The tag of the notice for several conversations; a click on it opens the chat list. */
export const ALL_CHATS = "c:";

export function conversationTag(conversation: string): string {
  return `c:${conversation}`;
}

function mentionsMe(state: SessionState, message: MessageRecord): boolean {
  const me = state.self?.name;
  return !!me && message.text.includes(`@[${me}]`);
}

/** The unread messages of a conversation, oldest first: the last ones in, as many as are unread. */
function unreadIn(state: SessionState, conversation: string): MessageRecord[] {
  const count = state.unread[conversation] ?? 0;
  if (count === 0) return [];
  return state.messages.filter((m) => m.conversation === conversation && m.direction === "in").slice(-count);
}

/** One message on its own: who said it, and where. */
function heading(state: SessionState, message: MessageRecord, title: string): string {
  if (mentionsMe(state, message)) return `${message.sender ?? title} mentioned you${message.sender && message.sender !== title ? ` in ${title}` : ""}`;
  if (message.sender && message.conversation.startsWith("ch:")) return `${message.sender} in ${title}`;
  return title;
}

/** One message among several: a channel's and a room's are named after their author. */
function line(message: MessageRecord, title: string): string {
  return message.sender && message.sender !== title ? `${message.sender}: ${message.text}` : message.text;
}

/** What a conversation's notice says, or nothing when all in it is read. */
export function conversationNotice(state: SessionState, conversation: string): Notice | null {
  const unread = unreadIn(state, conversation);
  const last = unread.at(-1);
  if (!last) return null;
  const title = titleOf(state, conversation);
  const tag = conversationTag(conversation);
  const count = state.unread[conversation] ?? unread.length;
  if (count === 1) return { title: heading(state, last, title), body: last.text, tag };
  const mentioned = unread.some((m) => mentionsMe(state, m));
  return {
    title: `${title} · ${count} new${mentioned ? ", you are mentioned" : ""}`,
    body: unread.slice(-LINES).map((m) => line(m, title)).join("\n"),
    tag,
  };
}

/** What the notice for several conversations says: every unread one, busiest first. */
export function allChatsNotice(state: SessionState): Notice | null {
  const chats = Object.entries(state.unread)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  if (chats.length === 0) return null;
  const total = chats.reduce((sum, [, n]) => sum + n, 0);
  const named = chats.slice(0, NAMED).map(([c, n]) => `${titleOf(state, c)} ${n}`);
  if (chats.length > NAMED) named.push("…");
  return {
    title: `${total} new ${total === 1 ? "message" : "messages"} in ${chats.length} ${chats.length === 1 ? "chat" : "chats"}`,
    body: named.join(", "),
    tag: ALL_CHATS,
  };
}

export interface Announcer {
  /** A message the radio has handed over (`MeshSession.onReceived`). */
  received(message: MessageRecord): void;
  /** The session changed: a drained queue is announced, and what was read loses its notice. */
  changed(): void;
  /** The app is in front of the reader, so the notice for several conversations has done its work. */
  opened(): void;
}

export function createAnnouncer(deps: {
  state: () => SessionState;
  /** The "Announce messages" switch. */
  wanted: () => boolean;
  show: (notice: Notice) => void;
  withdraw: (tag: string) => void;
}): Announcer {
  /** Messages handed over and not yet announced, by id. */
  const pending = new Set<string>();
  /** Conversations with a notice of their own out. */
  const out = new Set<string>();
  /** Whether the notice for several conversations is out. */
  let allOut = false;
  /** The unread counts at the last change, to see what has been read since. */
  let before = deps.state().unread;

  function announce(state: SessionState): void {
    // Each message by the conversation it is in now: one from an unknown
    // sender moves under the contact once the contact is read.
    const fresh = new Set<string>();
    for (const m of state.messages) {
      if (pending.has(m.id) && (state.unread[m.conversation] ?? 0) > 0) fresh.add(m.conversation);
    }
    pending.clear();
    if (fresh.size === 0 || !deps.wanted()) return;

    if (allOut || new Set([...out, ...fresh]).size > SEPARATE) {
      for (const c of out) deps.withdraw(conversationTag(c));
      out.clear();
      const notice = allChatsNotice(state);
      if (notice) {
        deps.show(notice);
        allOut = true;
      }
      return;
    }
    for (const c of fresh) {
      const notice = conversationNotice(state, c);
      if (!notice) continue;
      deps.show(notice);
      out.add(c);
    }
  }

  return {
    received(message) {
      pending.add(message.id);
      const state = deps.state();
      if (!state.syncing) announce(state);
    },

    changed() {
      const state = deps.state();
      if (state.unread !== before) {
        // Read here, in a chat or with "Mark as read", or deleted. A notice
        // from an earlier run has the same tag, so it goes as well.
        for (const [c, n] of Object.entries(before)) {
          if (n > 0 && !state.unread[c]) {
            deps.withdraw(conversationTag(c));
            out.delete(c);
          }
        }
        if (!Object.values(state.unread).some((n) => n > 0) && Object.values(before).some((n) => n > 0)) {
          deps.withdraw(ALL_CHATS);
          allOut = false;
        }
        before = state.unread;
      }
      if (pending.size > 0 && !state.syncing) announce(state);
    },

    opened() {
      if (!allOut) return;
      deps.withdraw(ALL_CHATS);
      allOut = false;
    },
  };
}
