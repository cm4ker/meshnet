/** A short line at the bottom of the screen for what an action did. One at a time. */

import { useSyncExternalStore } from "react";

export interface Toast {
  id: number;
  text: string;
  tone: "" | "error";
}

let current: Toast | null = null;
let next = 1;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function toast(text: string, tone: Toast["tone"] = ""): void {
  current = { id: next++, text, tone };
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    current = null;
    emit();
  }, tone === "error" ? 5000 : 2800);
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
