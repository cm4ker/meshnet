/**
 * A message to bring into sight in its chat: a result picked from the search
 * over all chats (#42). A chat opening takes it as it mounts; one already
 * open hears it.
 */

export interface Jump {
  conversation: string;
  id: string;
  /** What it was found by, marked in it. */
  query: string;
}

let pending: Jump | null = null;
const listeners = new Set<(jump: Jump) => void>();

export function jumpTo(jump: Jump): void {
  pending = jump;
  for (const listener of listeners) listener(jump);
}

/** The jump waiting for this chat, once. */
export function takeJump(conversation: string): Jump | null {
  if (pending?.conversation !== conversation) return null;
  const jump = pending;
  pending = null;
  return jump;
}

export function onJump(listener: (jump: Jump) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
