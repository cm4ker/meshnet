import { useState } from "react";
import { AdvType, aclRoleName, type ContactRecord, type SessionState } from "@meshnet/meshcore";
import { ago } from "../lib/format.js";
import { hopsLabel, managedNodes } from "../lib/nodes.js";
import { useSavedPasswords } from "../lib/secrets.js";
import { useSession } from "../lib/session.js";
import { IconButton } from "../ui/Button.js";
import { Avatar } from "./Avatar.js";
import { PlusIcon } from "./Icons.js";
import { SignIn } from "./node/SignIn.js";

type Filter = "all" | "repeater" | "room" | "sensor";

const FILTERS: { id: Filter; label: string; type: number | null }[] = [
  { id: "all", label: "All", type: null },
  { id: "repeater", label: "Repeaters", type: AdvType.Repeater },
  { id: "room", label: "Rooms", type: AdvType.Room },
  { id: "sensor", label: "Sensors", type: AdvType.Sensor },
];

/** A day without a status answer makes what the list shows about a node stale. */
const STALE_MS = 24 * 3600 * 1000;
const LOW_BATTERY_MV = 3600;

export function NodesList({ selected, onOpen }: { selected: string | null; onOpen: (key: string) => void }) {
  const state = useSession();
  const saved = useSavedPasswords();
  const [filter, setFilter] = useState<Filter>("all");
  const [adding, setAdding] = useState(false);
  const type = FILTERS.find((f) => f.id === filter)!.type;
  const rows = managedNodes(state, saved).filter((c) => type === null || c.type === type);
  const any = managedNodes(state, saved).length > 0;

  return (
    <div className="contacts">
      <div className="list-tools">
        <span className="list-title">Nodes</span>
        <IconButton label="Add a node" onClick={() => setAdding(true)} disabled={state.status !== "ready"}>
          <PlusIcon size={18} />
        </IconButton>
      </div>
      <div className="chips">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" className={["chip", filter === f.id ? "on" : ""].join(" ")} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <div className="empty muted">
          {any ? (
            "None of this kind."
          ) : (
            <span>
              Repeaters, rooms and sensors you sign in to are managed here.
              <br />
              <button type="button" className="link" onClick={() => setAdding(true)} disabled={state.status !== "ready"}>
                Add one from your contacts
              </button>
            </span>
          )}
        </div>
      ) : (
        <ul className="list" role="list">
          {rows.map((c) => {
            const health = healthOf(state, c);
            const when = state.statuses[c.key]?.at ?? state.statusHistory[c.key]?.at(-1)?.at ?? state.telemetry[c.key]?.at ?? null;
            return (
              <li key={c.key}>
                <button type="button" className={["row", selected === c.key ? "selected" : ""].join(" ")} onClick={() => onOpen(c.key)}>
                  <Avatar name={c.name || c.prefix} type={c.type} />
                  <span className="row-main">
                    <span className="row-top">
                      <span className="row-title">{c.name || c.prefix}</span>
                      <span className="row-when muted">{when ? ago(when) : ""}</span>
                    </span>
                    <span className="row-bottom">
                      <span className="row-sub muted">{summary(state, c)}</span>
                      <span className={["dot", health.cls].join(" ")} title={health.label} aria-label={health.label} />
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="pane-foot muted">Signed in to, or with a password kept. Nothing here asks the air on its own.</div>
      <SignIn
        open={adding}
        nodeKey={null}
        onClose={() => setAdding(false)}
        onSignedIn={(key) => {
          setAdding(false);
          onOpen(key);
        }}
      />
    </div>
  );
}

function summary(state: SessionState, c: ContactRecord): string {
  const login = state.logins[c.key];
  const bits = [login?.ok ? (login.role === null ? "signed in" : aclRoleName(login.role)) : "not signed in", hopsLabel(c)];
  const last = state.statusHistory[c.key]?.at(-1);
  if (last) bits.push(`${(last.batteryMv / 1000).toFixed(2)} V`);
  const posted = state.statuses[c.key]?.stats?.posted;
  if (c.type === AdvType.Room && posted != null) bits.push(`${posted} posts`);
  return bits.join(" · ");
}

function healthOf(state: SessionState, c: ContactRecord): { cls: string; label: string } {
  if (c.type === AdvType.Sensor) {
    const readings = state.telemetry[c.key];
    return readings && Date.now() - readings.at < STALE_MS ? { cls: "on", label: "Readings in the last day" } : { cls: "stale", label: "No readings in the last day" };
  }
  const last = state.statusHistory[c.key]?.at(-1);
  if (!last || Date.now() - last.at > STALE_MS) return { cls: "stale", label: "No status in the last day" };
  if (last.batteryMv > 0 && last.batteryMv < LOW_BATTERY_MV) return { cls: "warn", label: "Battery low" };
  return { cls: "on", label: "Healthy at the last status" };
}
