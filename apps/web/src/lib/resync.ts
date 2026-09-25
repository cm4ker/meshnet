/**
 * Reading everything from the radio again, as at connect, on the link as it
 * is. One run at a time; the step it is on is shown while it runs.
 */

import { RESYNC_STEPS, ResyncError, type ResyncStep } from "@meshnet/meshcore";
import { useSyncExternalStore } from "react";
import { errorText } from "../i18n/errors.js";
import { t, type Key } from "../i18n/index.js";
import { session } from "./session.js";
import { toast } from "./toast.js";

export const STEP_LABELS: Record<ResyncStep, Key> = {
  device: "radio.steps.device",
  self: "radio.steps.self",
  clock: "radio.steps.clock",
  contacts: "radio.steps.contacts",
  channels: "radio.steps.channels",
  autoAdd: "radio.steps.autoAdd",
  messages: "radio.steps.messages",
  battery: "radio.steps.battery",
};

/** A step's name in the reader's language. */
export function stepLabel(step: ResyncStep): string {
  return t(STEP_LABELS[step]);
}

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
    const news = [contacts ? t("radio.resync.newContacts", { count: contacts }) : "", messages ? t("radio.resync.messages", { count: messages }) : ""].filter(Boolean);
    toast(news.length ? news.join(" · ") : t("radio.resync.nothingNew"));
  } catch (error) {
    const at = error instanceof ResyncError ? t("radio.resync.stoppedAt", { step: stepLabel(error.step) }) : errorText(error);
    toast(at, "error", { label: t("common.tryAgain"), run: () => void resync() });
  } finally {
    set(null);
  }
}
