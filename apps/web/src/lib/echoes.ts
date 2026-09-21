import { AdvType, type ContactRecord, type MessageEcho } from "@meshnet/meshcore";

export interface Relay {
  /** The hash the node signs the path with: the first bytes of its key, hex. */
  hash: string;
  /** Its name when exactly one contact's key starts with the hash. */
  name: string | null;
}

/** Every node that relayed the message, in the order they first appear in the echoes heard. */
export function relaysOf(echoes: MessageEcho[], contacts: Record<string, ContactRecord>): Relay[] {
  const seen = new Map<string, Relay>();
  for (const echo of echoes) {
    for (const hash of echo.path) {
      if (!seen.has(hash)) seen.set(hash, { hash, name: nameOfHash(hash, contacts) });
    }
  }
  return [...seen.values()];
}

/**
 * The contacts a path hash could be: those whose key starts with it, the
 * repeaters and rooms among them when there are any, since only they relay.
 * With one-byte hashes on a busy mesh there are often several.
 */
export function candidatesOfHash(hash: string, contacts: Record<string, ContactRecord>): ContactRecord[] {
  const all = Object.values(contacts).filter((c) => c.key.startsWith(hash));
  const relaying = all.filter((c) => c.type === AdvType.Repeater || c.type === AdvType.Room);
  return relaying.length > 0 ? relaying : all;
}

export function nameOfHash(hash: string, contacts: Record<string, ContactRecord>): string | null {
  const matches = candidatesOfHash(hash, contacts);
  return matches.length === 1 ? matches[0]!.name : null;
}
