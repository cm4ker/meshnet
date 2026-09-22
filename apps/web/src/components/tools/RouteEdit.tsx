/**
 * Changing the route to a contact by tapping repeaters on the map, in order.
 * The sheet shows the chain as it grows and warns only of a leg the terrain
 * closes; saving writes it to the radio and sends nothing on the air.
 */

import { contactRoute } from "@meshnet/meshcore";
import { useState } from "react";
import { legId, useLegVerdicts } from "../../lib/legVerdicts.js";
import type { LinkRadio } from "../../lib/los.js";
import { contactEnd, defaultHeight, selfEnd } from "../../lib/mapOverlay.js";
import { setMeshTool, type MeshTool } from "../../lib/meshTool.js";
import { showOnMap } from "../../lib/nav.js";
import { clearPing } from "../../lib/ping.js";
import { session, useSession } from "../../lib/session.js";
import { act } from "../../lib/toast.js";
import { Button, IconButton } from "../../ui/Button.js";
import { AlertIcon, BackIcon, CloseIcon } from "../Icons.js";

export function RouteEdit({ tool, onClose }: { tool: Extract<MeshTool, { kind: "route" }>; onClose: () => void }) {
  const state = useSession();
  const [saving, setSaving] = useState(false);
  const target = state.contacts[tool.key];
  const self = state.self;
  const radio: LinkRadio | null = self ? { frequencyKhz: self.frequencyKhz, bandwidthHz: self.bandwidthHz, spreadingFactor: self.spreadingFactor, codingRate: self.codingRate, txPowerDbm: self.txPower } : null;
  const ends = [selfEnd(state), ...tool.relays.map((k) => (state.contacts[k] ? contactEnd(state.contacts[k]) : null)), target ? contactEnd(target) : null];
  const legs = ends.slice(1).flatMap((b, i) => {
    const a = ends[i];
    return a && b ? [{ a, b, ha: defaultHeight(a, state.contacts), hb: defaultHeight(b, state.contacts) }] : [];
  });
  const verdicts = useLegVerdicts(legs, radio);
  if (!target) return null;
  const name = (key: string) => state.contacts[key]?.name || key.slice(0, 8);
  const closed = legs.filter((l) => verdicts.get(legId(l.a, l.b)) === "blocked");

  const save = async () => {
    const current = contactRoute(target);
    const size = current?.[0] ? current[0].length / 2 : (state.device?.pathHashMode ?? 0) + 1;
    setSaving(true);
    const ok = await act(() => session.setRoute(tool.key, tool.relays.map((k) => k.slice(0, size * 2))), "Route saved");
    setSaving(false);
    if (!ok) return;
    clearPing(tool.key);
    setMeshTool(null);
    showOnMap(tool.key);
  };

  return (
    <div className="tool">
      <div className="tool-head">
        <IconButton label="Back" onClick={onClose}>
          <BackIcon size={18} />
        </IconButton>
        <span className="row-main">
          <span className="row-title">Route to {target.name || target.prefix}</span>
          <span className="row-sub muted">Tap repeaters on the map in order</span>
        </span>
        <IconButton label="Close" onClick={onClose}>
          <CloseIcon size={18} />
        </IconButton>
      </div>
      <p className="tool-line chain">
        <span className="muted">You</span>
        {tool.relays.map((k) => (
          <span key={k}>
            <span className="sep">›</span>
            <b>{name(k)}</b>
          </span>
        ))}
        <span className="sep">›</span>
        <span className="muted">{target.name || target.prefix}</span>
      </p>
      {tool.relays.length === 0 ? <p className="tool-note muted">No relays: messages go straight to {target.name || "it"}. Tap a repeater to go through it, tap it again to take it off.</p> : null}
      {closed.map((l) => (
        <p key={legId(l.a, l.b)} className="tool-warn">
          <AlertIcon size={16} />
          {l.a.name} → {l.b.name} is blocked by terrain.
        </p>
      ))}
      <div className="tool-actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={saving} disabled={state.status !== "ready"} onClick={() => void save()}>
          Save route
        </Button>
      </div>
      <p className="tool-credit muted">Saved to the radio; it holds until the radio learns another route. Nothing goes on the air.</p>
    </div>
  );
}
