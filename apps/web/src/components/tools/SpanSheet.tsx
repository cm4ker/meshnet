/**
 * How two repeaters hear each other, checked from this radio: the trace goes
 * to the first along the route held to it (or the likeliest way the radio
 * has heard of), on to the second, and home the same way, so each leg
 * between them is heard both ways. The first is the repeater whose route it
 * was opened from; the second is tapped on the map. The way there only
 * leads to it: the word and the weakest leg are of the part between them.
 */

import { nameOfHash } from "../../lib/echoes.js";
import type { SpanTool } from "../../lib/meshTool.js";
import { keepLooking, measuredLegs, ping, spanKey, stopPing, usePing } from "../../lib/ping.js";
import { useSession } from "../../lib/session.js";
import { openLineOfSight } from "../../lib/toolActions.js";
import { Button } from "../../ui/Button.js";
import { chainEnds, CheckResult, SheetHead } from "./RouteSheet.js";

export function SpanSheet({ tool, onClose }: { tool: SpanTool; onClose: () => void }) {
  const state = useSession();
  const key = tool.to ? spanKey(tool.from, tool.to) : null;
  const p = usePing(key);
  const a = state.contacts[tool.from];
  const b = tool.to ? state.contacts[tool.to] : null;
  const nameA = a ? a.name || a.prefix : "?";
  const online = state.status === "ready";

  if (!b || !key) {
    return (
      <div className="tool route-sheet">
        <SheetHead title={`Check from ${nameA}`} sub="Tap a repeater on the map" onBack={onClose} />
        <p className="tool-credit muted">The way from you to {nameA}, and home from the one you tap, comes from what the radio has heard.</p>
      </div>
    );
  }

  const nameB = b.name || b.prefix;
  const running = p?.running ?? false;
  // A search that found nothing goes on from where it stopped.
  const gaveUp = !running && !!p?.search?.done && !p.search.found;
  const name = (h: string) => nameOfHash(h, state.contacts) ?? h;
  // The chain as traced: the way to the first repeater, then on to the second.
  const chain = p && p.chain.length ? p.chain : null;
  const approach = chain && p ? chain.slice(0, Math.max(0, p.from)) : [];
  const between = chain && p ? chain.slice(Math.max(0, p.from)) : [];
  const names = chain ? ["You", ...chain.map(name)] : [];
  const openLeg = (index: number) => {
    if (!p) return;
    const ends = chainEnds(p.chain, state);
    const x = ends[index];
    const y = ends[index + 1];
    if (x && y) openLineOfSight(x, y, null, measuredLegs(p)[index] ?? null);
  };

  return (
    <div className="tool route-sheet">
      <SheetHead title={`${nameA} → ${nameB}`} sub="Measured from your radio" onBack={onClose} />
      {between.length ? (
        <p className="tool-line chain">
          {between.map((h, i) => (
            <span key={`${i}:${h}`}>
              {i > 0 ? <span className="sep">›</span> : null}
              <b>{name(h)}</b>
            </span>
          ))}
        </p>
      ) : null}
      {approach.length ? <p className="tool-credit muted">Reached from you via {approach.map(name).join(" › ")}</p> : null}
      {p ? <CheckResult p={p} names={names} reach={null} placed onLeg={openLeg} /> : null}
      <Button variant={running ? "default" : "primary"} size="lg" disabled={!online} onClick={() => (running ? stopPing(key) : gaveUp ? void keepLooking(key) : void ping(key))}>
        {running ? "Stop" : gaveUp ? "Keep looking" : "Check"}
      </Button>
      {!p ? <p className="tool-credit muted">Tap another repeater to change the far end.</p> : null}
    </div>
  );
}
