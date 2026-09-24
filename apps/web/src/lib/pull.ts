/**
 * Pull down from the top of a scrolling list to run something. Only a touch
 * that starts with the list at its top and moves down more than across is
 * taken; the rest scrolls as ever.
 */

import { useEffect, useState, type RefObject } from "react";

/** How far the finger goes, in px, for the list to move one. */
const RESIST = 0.5;
/** How far the list must come down to run on release. */
export const PULL_TRIGGER = 64;
const PULL_MAX = 96;

export function usePull(ref: RefObject<HTMLElement | null>, onPull: () => void, enabled: boolean): number {
  const [pull, setPull] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    let start: { x: number; y: number } | null = null;
    let pulling = false;
    let distance = 0;
    const down = (e: TouchEvent) => {
      const t = e.touches[0];
      start = e.touches.length === 1 && t && el.scrollTop <= 0 ? { x: t.clientX, y: t.clientY } : null;
      pulling = false;
    };
    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!start || !t) return;
      const dy = t.clientY - start.y;
      if (!pulling) {
        if (Math.abs(dy) < 8 && Math.abs(t.clientX - start.x) < 8) return;
        if (dy <= 0 || Math.abs(t.clientX - start.x) > dy) {
          start = null;
          return;
        }
        pulling = true;
      }
      // Held here, so the page does not bounce under the pull as well.
      e.preventDefault();
      distance = Math.min(PULL_MAX, Math.max(0, dy * RESIST));
      setPull(distance);
    };
    const up = () => {
      if (pulling && distance >= PULL_TRIGGER) onPull();
      start = null;
      pulling = false;
      distance = 0;
      setPull(0);
    };
    el.addEventListener("touchstart", down, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", up);
    el.addEventListener("touchcancel", up);
    return () => {
      el.removeEventListener("touchstart", down);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", up);
      el.removeEventListener("touchcancel", up);
    };
  }, [ref, onPull, enabled]);
  return pull;
}
