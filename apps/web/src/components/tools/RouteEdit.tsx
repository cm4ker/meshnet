/**
 * Changing the route to a contact on the map: its relays dragged onto other
 * repeaters, a leg dragged onto one to go through it, or repeaters tapped in
 * order. The sheet shows the chain as it stands, warns only of a leg the
 * terrain closes, and pings it before it is kept; saving writes it to the
 * radio and sends nothing on the air.
 */

import { AdvType, contactRoute } from "@meshnet/meshcore";
import { useState } from "react";
import { legId, useLegVerdicts } from "../../lib/legVerdicts.js";
import type { LinkRadio } from "../../lib/los.js";
import { contactEnd, defaultHeight, relayOf, sameRelays, selfEnd } from "../../lib/mapOverlay.js";
import { setMeshTool, type MeshTool } from "../../lib/meshTool.js";
import { showOnMap } from "../../lib/nav.js";
import { measuredLegs, ping, settlePing, stopPing, usePing } from "../../lib/ping.js";
import { session, useSession } from "../../lib/session.js";
import { act } from "../../lib/toast.js";
import { openLineOfSight } from "../../lib/toolActions.js";
import { Button, IconButton } from "../../ui/Button.js";
import { AlertIcon, BackIcon, CloseIcon, SignalIcon } from "../Icons.js";
import { legEnds, PingResult } from "./NodeCheck.js";

export function RouteEdit({ tool, onClose }: { tool: Extract<MeshTool, { kind: "route" }>; onClose: () => void }) {
  const state = useSession();
  const [saving, setSaving] = useState(false);
  const p = usePing(tool.key);
  const target = state.contacts[tool.key];
  const self = state.self;
  const radio: LinkRadio | null = self ? { frequencyKhz: self.frequencyKhz, bandwidthHz: self.bandwidthHz, spreadingFactor: self.spreadingFactor, codingRate: self.codingRate, txPowerDbm: self.txPower } : null;
  const nodeOf = (k: string) => state.contacts[k] ?? relayOf(k, state.contacts);
  const ends = [selfEnd(state), ...tool.relays.map((k) => { const c = nodeOf(k); return c ? contactEnd(c) : null; }), target ? contactEnd(target) : null];
  const legs = ends.slice(1).flatMap((b, i) => {
    const a = ends[i];
    return a && b ? [{ a, b, ha: defaultHeight(a, state.contacts), hb: defaultHeight(b, state.contacts) }] : [];
  });
  const verdicts = useLegVerdicts(legs, radio);
  if (!target) return null;
  const name = (key: string) => nodeOf(key)?.name || key.slice(0, 8);
  const closed = legs.filter((l) => verdicts.get(legId(l.a, l.b)) === "blocked");
  const online = state.status === "ready";

  // The route as the radio would hold it: hashes the size of the one it holds now.
  const current = contactRoute(target);
  const size = current?.[0] ? current[0].length / 2 : (state.device?.pathHashMode ?? 0) + 1;
  const hashes = tool.relays.map((k) => k.slice(0, size * 2));
  const relaysItself = target.type === AdvType.Repeater;
  const canPing = relaysItself || hashes.length > 0;
  // What was measured along this chain, not along one it was before a drag.
  const pinged = p?.via && sameRelays(p.via, tool.relays) ? p : null;
  const running = pinged?.running ?? false;

  const save = async () => {
    setSaving(true);
    const ok = await act(() => session.setRoute(tool.key, hashes), "Route saved");
    setSaving(false);
    if (!ok) return;
    settlePing(tool.key, hashes);
    setMeshTool(null);
    showOnMap(tool.key);
  };

  const openLeg = (index: number) => {
    if (!pinged) return;
    const at = legEnds(pinged, target, state, index);
    if (at) openLineOfSight(at.a, at.b, tool.key, measuredLegs(pinged)[index] ?? null);
  };

  return (
    <div className="tool">
      <div className="tool-head">
        <IconButton label="Back" onClick={onClose}>
          <BackIcon size={18} />
        </IconButton>
        <span className="row-main">
          <span className="row-title">Route to {target.name || target.prefix}</span>
          <span className="row-sub muted">Drag a point onto a repeater, or tap them in order</span>
        </span>
        <IconButton label="Close" onClick={onClose}>
          <CloseIcon size={18} />
        </IconButton>
      </div>
      <p className="tool-line chain">
        <span className="muted">You</span>
        {tool.relays.map((k, i) => (
          <span key={`${i}:${k}`}>
            <span className="sep">›</span>
            <b>{name(k)}</b>
          </span>
        ))}
        <span className="sep">›</span>
        <span className="muted">{target.name || target.prefix}</span>
      </p>
      {tool.relays.length === 0 ? <p className="tool-note muted">No relays: messages go straight to {target.name || "it"}. Drag the line onto a repeater to go through it.</p> : null}
      {closed.map((l) => (
        <p key={legId(l.a, l.b)} className="tool-warn">
          <AlertIcon size={16} />
          {l.a.name} → {l.b.name} is blocked by terrain.
        </p>
      ))}
      {pinged ? <PingResult p={pinged} contact={target} state={state} onLeg={openLeg} /> : null}
      <div className="tool-actions">
        <Button disabled={!online || (!canPing && !running)} onClick={() => (running ? stopPing(tool.key) : void ping(tool.key, hashes))}>
          <SignalIcon size={16} />
          {running ? "Stop" : relaysItself ? "Ping" : "Check"}
        </Button>
        <Button variant="primary" busy={saving} disabled={!online || running} onClick={() => void save()}>
          Save route
        </Button>
      </div>
      <p className="tool-credit muted">
        {relaysItself ? "Ping goes out this way and back before anything is kept." : "Check pings the way to the last repeater."} Saving writes it to the radio and sends nothing.
      </p>
    </div>
  );
}
