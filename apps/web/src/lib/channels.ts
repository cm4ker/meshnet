/** Channels as the chats see them: where a new one goes, and the key it starts with. */

import type { SessionState } from "@meshnet/meshcore";

/** The first slot the radio has free, or -1. */
export function freeChannelIndex(state: SessionState): number {
  const used = new Set(state.channels.map((c) => c.index));
  const max = state.device?.maxChannels ?? 8;
  for (let i = 0; i < max; i++) if (!used.has(i)) return i;
  return -1;
}

export function randomSecret(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A key as typed or pasted: spaces and dashes dropped, lower case; null unless it is 32 hex digits. */
export function parseSecret(text: string): string | null {
  const hex = text.replace(/[\s-]+/g, "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(hex) ? hex : null;
}

/**
 * A public channel's name as it is keyed: one leading "#", lower case, no
 * spaces; null when nothing is left. Everyone who types "#Berlin" or "berlin"
 * lands on the same channel.
 */
export function hashtagName(text: string): string | null {
  const bare = text.trim().replace(/^#+/, "").replace(/\s+/g, "").toLowerCase();
  return bare ? `#${bare}` : null;
}

/** A public channel's key: the first 16 bytes of SHA-256 of its name, "#" included, as MeshCore derives it. */
export async function hashtagSecret(name: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name)));
  return Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}
