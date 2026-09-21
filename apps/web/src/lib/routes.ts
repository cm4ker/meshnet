/** How the views talk about a contact's route and its time limit. */

import type { ContactRecord } from "@meshnet/meshcore";
import { useEffect, useState } from "react";
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
