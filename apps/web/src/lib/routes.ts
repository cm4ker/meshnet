/** How the views talk about a contact's route and its time limit. */

import { contactHops, isConversationType, type ContactRecord } from "@meshnet/meshcore";
import { useEffect, useState } from "react";
import type { Discovery } from "./discovery.js";
import type { Ping } from "./ping.js";
import { session } from "./session.js";

/** The time limits offered for a learned route, in minutes; null keeps it. */
export const ROUTE_LIMITS: (number | null)[] = [null, 5, 15, 30, 60];

export function limitLabel(minutes: number | null): string {
  if (minutes === null) return "Never";
  if (minutes === 60) return "1 hour";
  return `${minutes} min`;
}

/** `<select>` values: "default", "never", or minutes. */
export function limitValue(minutes: number | null | undefined): string {
  return minutes === undefined ? "default" : minutes === null ? "never" : String(minutes);
}

export function parseLimit(value: string): number | null | undefined {
  return value === "default" ? undefined : value === "never" ? null : Number(value);
}

/** "in 3 min", "in 1 h 5 min"; never less than a minute, so a countdown does not read zero. */
export function inMinutes(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return `in ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `in ${h} h${m ? ` ${m} min` : ""}`;
}

/** The chat header's line about a contact's route. */
export function routeSubtitle(contact: ContactRecord, now: number): { text: string; tone: "" | "pinned" | "soon" } {
  if (session.routePolicy(contact.key).flood) return { text: "Flood · pinned", tone: "pinned" };
  if (contact.outPathLen === 0xff) return { text: "No route known: messages flood", tone: "" };
  const hops = contact.outPathLen & 63;
  const lead = hops === 0 ? "Direct" : `${hops} hop${hops === 1 ? "" : "s"}`;
  const expires = session.routeExpiresAt(contact.key);
  if (expires === null) return { text: lead, tone: "" };
  const left = expires - now;
  return { text: `${lead} · drops ${inMinutes(left)}`, tone: left <= 3 * 60_000 ? "soon" : "" };
}

/** The clock, ticking every `ms`, for countdowns. */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** A contact's route in a few words, for under a name: how the next message goes. */
export function routeWords(contact: ContactRecord): { text: string; tone: "" | "pinned" | "none" } {
  if (isConversationType(contact.type) && session.routePolicy(contact.key).flood) return { text: "always flood", tone: "pinned" };
  const hops = contactHops(contact);
  if (hops === null) return { text: "no route · floods", tone: "none" };
  if (hops === 0) return { text: "direct", tone: "" };
  return { text: `via ${hops} relay${hops === 1 ? "" : "s"}`, tone: "" };
}

/**
 * A contact's route in a few words, and what the last check of it or search
 * for it came to, whichever is newer: the row that opens the route.
 */
export function routeStatus(contact: ContactRecord, ping: Ping | null, found: Discovery | null): { text: string; tone: "" | "pinned" | "none" | "good" | "bad" } {
  const words = routeWords(contact);
  const checked = ping && !ping.via ? ping : null;
  if (found && (!checked || found.at >= checked.at)) {
    if (found.running) return { text: `${words.text} · looking…`, tone: words.tone };
    if (found.silent) return { text: `${words.text} · no answer`, tone: "bad" };
    return words;
  }
  if (!checked) return words;
  if (checked.running) return { text: `${words.text} · checking…`, tone: words.tone };
  if (checked.mode === "hops" || checked.runs.length === 0) return words;
  return checked.runs.some((r) => r.ok) ? { text: `${words.text} · works`, tone: "good" } : { text: `${words.text} · no answer`, tone: "bad" };
}
