/** A short line at the bottom of the screen for what an action did. One at a time. */

import { useSyncExternalStore } from "react";

export interface Toast {
  id: number;
  text: string;
  tone: "" | "error";
  /** A button in the toast, such as Undo; the toast stays longer for it. */
  action?: { label: string; run: () => void } | undefined;
}

let current: Toast | null = null;
let next = 1;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function toast(text: string, tone: Toast["tone"] = "", action?: Toast["action"]): void {
  current = { id: next++, text, tone, action };
  if (timer) clearTimeout(timer);
  timer = setTimeout(dismissToast, action ? 8000 : tone === "error" ? 5000 : 2800);
  emit();
}

export function dismissToast(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  current = null;
  emit();
}

export function useToast(): Toast | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

/** Runs an action, says what it did, or why it failed. */
export async function act(action: () => Promise<unknown>, done?: string): Promise<boolean> {
  try {
    await action();
    if (done) toast(done);
    return true;
  } catch (error) {
    toast((error as Error).message, "error");
    return false;
  }
}
