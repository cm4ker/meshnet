import type { ContactRecord, MessageEcho } from "@meshnet/meshcore";

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

export function nameOfHash(hash: string, contacts: Record<string, ContactRecord>): string | null {
  const matches = Object.values(contacts).filter((c) => c.key.startsWith(hash));
  return matches.length === 1 ? matches[0]!.name : null;
}
