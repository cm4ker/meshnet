import type { ContactRecord, MessageRecord } from "@meshnet/meshcore";
import { heardAt } from "./nodes.js";

/**
 * The contacts a message heard in a channel or a room could be from, the one
 * heard most lately first. A room post names its author by the first bytes of
 * the key, which finds the node itself. A channel message carries only the
 * name before the colon, and anyone may write under any name: every contact
 * of that name is a candidate, and there may be none.
 */
export function sendersOf(message: MessageRecord, contacts: Record<string, ContactRecord>): ContactRecord[] {
  const prefix = message.senderPrefix;
  const name = message.sender;
  const found = prefix ? Object.values(contacts).filter((c) => c.key.startsWith(prefix)) : name ? Object.values(contacts).filter((c) => c.name === name) : [];
  return found.sort((a, b) => heardAt(b) - heardAt(a));
}
