/**
 * Whether the terrain closes a leg, for legs looked at together (a route
 * being changed): each worked out once from the elevation tiles and kept
 * while the app runs, so the sheet and the map share the answer.
 */

import { useEffect, useSyncExternalStore } from "react";
import { profileBetween } from "./elevation.js";
import { lineOfSight, type LinkRadio, type Verdict } from "./los.js";
import type { LosEnd } from "./meshTool.js";

const verdicts = new Map<string, Verdict | "unknown">();
const pending = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

export const legId = (a: LosEnd, b: LosEnd) => `${a.lat.toFixed(5)},${a.lon.toFixed(5)}|${b.lat.toFixed(5)},${b.lon.toFixed(5)}`;

function publish(): void {
  version++;
  for (const listener of listeners) listener();
}

/** The verdict for each leg as it becomes known; a leg still being read, or with no terrain to read, is absent. */
export function useLegVerdicts(legs: { a: LosEnd; b: LosEnd; ha: number; hb: number }[], radio: LinkRadio | null): Map<string, Verdict> {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
  const ids = legs.map((l) => `${legId(l.a, l.b)}@${l.ha},${l.hb}`);
  useEffect(() => {
    if (!radio) return;
    legs.forEach((leg, i) => {
      const id = ids[i]!;
      if (verdicts.has(id) || pending.has(id)) return;
      pending.add(id);
      profileBetween(leg.a, leg.b)
        .then((profile) => verdicts.set(id, lineOfSight(profile, leg.ha, leg.hb, radio).verdict))
        .catch(() => verdicts.set(id, "unknown"))
        .finally(() => {
          pending.delete(id);
          publish();
        });
    });
    // What to read is decided by the legs themselves, named by `ids`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join(";"), radio]);
  const out = new Map<string, Verdict>();
  legs.forEach((leg, i) => {
    const v = verdicts.get(ids[i]!);
    if (v && v !== "unknown") out.set(legId(leg.a, leg.b), v);
  });
  return out;
}
