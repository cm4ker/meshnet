/**
 * Reading everything from the radio again, as at connect, on the link as it
 * is. One run at a time; the step it is on is shown while it runs.
 */

import { RESYNC_STEPS, ResyncError, type ResyncStep } from "@meshnet/meshcore";
import { useSyncExternalStore } from "react";
import { plural } from "./format.js";
import { session } from "./session.js";
import { toast } from "./toast.js";

export const STEP_LABELS: Record<ResyncStep, string> = {
  device: "Device",
  self: "This radio",
  clock: "Clock",
  contacts: "Contacts",
  channels: "Channels",
  autoAdd: "Auto-add",
  messages: "Waiting messages",
  battery: "Battery",
};

export const STEP_COUNT = RESYNC_STEPS.length;

/** The step running now and its place, or null when nothing runs. */
export type ResyncProgress = { step: ResyncStep; index: number } | null;

let progress: ResyncProgress = null;
const listeners = new Set<() => void>();

function set(next: ResyncProgress): void {
  progress = next;
  for (const listener of listeners) listener();
}

export function useResync(): ResyncProgress {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => progress,
  );
}

export async function resync(): Promise<void> {
  if (progress) return;
  set({ step: RESYNC_STEPS[0], index: 0 });
  try {
    const { contacts, messages } = await session.resync((step, index) => set({ step, index }));
    const news = [contacts ? plural(contacts, "new contact") : "", messages ? plural(messages, "message") : ""].filter(Boolean);
    toast(news.length ? news.join(" · ") : "Nothing new on the radio");
  } catch (error) {
    const at = error instanceof ResyncError ? `Radio stopped answering at ${STEP_LABELS[error.step]}` : (error as Error).message;
    toast(at, "error", { label: "Try again", run: () => void resync() });
  } finally {
    set(null);
  }
}
