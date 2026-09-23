/**
 * What the chat list shows: one row per conversation, from the session's
 * flat message list. Pure, so the shape of the list is testable without a
 * radio.
 */

import {
  channelConversation,
  contactConversation,
  parseConversation,
  TxtType,
  type ChannelRecord,
  type ContactRecord,
  type MessageRecord,
  type SessionState,
} from "@meshnet/meshcore";

export interface ConversationSummary {
  id: string;
  kind: "channel" | "contact" | "prefix";
  title: string;
  /** The last message, with its sender on a channel. */
  preview: string | null;
  /** Local ms of the last message, or 0 for a channel nobody has spoken on. */
  lastAt: number;
  unread: number;
  contact: ContactRecord | null;
  channel: ChannelRecord | null;
}

function preview(message: MessageRecord, kind: ConversationSummary["kind"]): string {
  if (message.direction === "out") return `You: ${message.text}`;
  // A room's posts carry their author the way a channel's messages do.
  if ((kind === "channel" || message.txtType === TxtType.SignedPlain) && message.sender) return `${message.sender}: ${message.text}`;
  return message.text;
}

export function summarize(state: SessionState): ConversationSummary[] {
  const last = new Map<string, MessageRecord>();
  for (const m of state.messages) {
    const prior = last.get(m.conversation);
    if (!prior || m.receivedAt >= prior.receivedAt) last.set(m.conversation, m);
  }

  const rows: ConversationSummary[] = [];
  const seen = new Set<string>();

  for (const channel of state.channels) {
    const id = channelConversation(channel.index);
    seen.add(id);
    const m = last.get(id);
    rows.push({
      id,
      kind: "channel",
      title: channel.name || `Channel ${channel.index}`,
      preview: m ? preview(m, "channel") : null,
      lastAt: m?.receivedAt ?? 0,
      unread: state.unread[id] ?? 0,
      contact: null,
      channel,
    });
  }

  for (const [id, m] of last) {
    if (seen.has(id)) continue;
    seen.add(id);
    const target = parseConversation(id);
    if (target.kind === "channel") {
      rows.push({
        id,
        kind: "channel",
        title: `Channel ${target.index}`,
        preview: preview(m, "channel"),
        lastAt: m.receivedAt,
        unread: state.unread[id] ?? 0,
        contact: null,
        channel: null,
      });
    } else if (target.kind === "contact") {
      const contact = state.contacts[target.key] ?? null;
      rows.push({
        id,
        kind: "contact",
        title: contact?.name || target.key.slice(0, 12),
        preview: preview(m, "contact"),
        lastAt: m.receivedAt,
        unread: state.unread[id] ?? 0,
        contact,
        channel: null,
      });
    } else {
      rows.push({
        id,
        kind: "prefix",
        title: `Unknown ${target.prefix}`,
        preview: preview(m, "prefix"),
        lastAt: m.receivedAt,
        unread: state.unread[id] ?? 0,
        contact: null,
        channel: null,
      });
    }
  }

  rows.sort((a, b) => {
    if (a.lastAt !== b.lastAt) return b.lastAt - a.lastAt;
    if (a.channel && b.channel) return a.channel.index - b.channel.index;
    return a.title.localeCompare(b.title);
  });
  return rows;
}

export function messagesIn(state: SessionState, conversation: string): MessageRecord[] {
  return state.messages
    .filter((m) => m.conversation === conversation)
    .sort((a, b) => a.timestamp - b.timestamp || a.receivedAt - b.receivedAt);
}

export function titleOf(state: SessionState, conversation: string): string {
  const target = parseConversation(conversation);
  if (target.kind === "channel") {
    const channel = state.channels.find((c) => c.index === target.index);
    return channel?.name || `Channel ${target.index}`;
  }
  if (target.kind === "contact") return (state.contacts[target.key] ?? state.removed[target.key]?.contact)?.name || target.key.slice(0, 12);
  return `Unknown ${target.prefix}`;
}

export function totalUnread(state: SessionState): number {
  let n = 0;
  for (const v of Object.values(state.unread)) n += v;
  return n;
}

export { contactConversation, channelConversation };
