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
