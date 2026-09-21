import { useState } from "react";
import { contactRoute } from "@meshnet/meshcore";
import { nameOfHash } from "../lib/echoes.js";
import { ago, timeOfDay } from "../lib/format.js";
import { inMinutes, limitLabel, limitValue, parseLimit, ROUTE_LIMITS, useNow } from "../lib/routes.js";
import { session, useSession } from "../lib/session.js";
import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Field, Row, Select, Toggle } from "../ui/Field.js";

/** The route to a contact: what the radio holds, how long it is kept, and whether messages flood instead. */
export function RouteDialog({ contactKey, open, onClose }: { contactKey: string; open: boolean; onClose: () => void }) {
  const state = useSession();
  const now = useNow();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const contact = state.contacts[contactKey];
  if (!contact) return null;
  const name = contact.name || contact.prefix;
  const policy = session.routePolicy(contactKey);
  const own = state.routing.contacts[contactKey]?.resetAfterMin;
  const route = contactRoute(contact);
  const expires = session.routeExpiresAt(contactKey);
  const online = state.status === "ready";

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} title={`Route to ${name}`} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      {policy.flood ? (
        <p className="muted small">Flood is pinned: every route the radio learns is dropped, so each message floods.</p>
      ) : route ? (
        <div className="kv-grid">
          <Row label="Relays">{route.length === 0 ? "none: a neighbour, heard direct" : route.map((h) => nameOfHash(h, state.contacts) ?? `${h}?`).join(" › ")}</Row>
          {contact.pathSince ? <Row label="Learned">{`${since(contact.pathSince, now)} · ${timeOfDay(contact.pathSince / 1000)}`}</Row> : null}
          <Row label="Dropped">{expires === null ? "when the radio learns another" : `at ${timeOfDay(expires / 1000)} · ${inMinutes(expires - now)}`}</Row>
        </div>
      ) : (
        <p className="muted small">No route. The next message floods, and its acknowledgement brings a fresh route back.</p>
      )}
      <Toggle
        label="Always flood"
        hint="Messages to this contact ignore learned routes. Handy on the move; costs the mesh two floods a message."
        checked={policy.flood}
        onChange={(v) => void act(() => session.setFloodPinned(contactKey, v))}
      />
      <Field label="Drop the route after">
        <Select value={limitValue(own)} disabled={policy.flood} onChange={(e) => session.setRouteReset(contactKey, parseLimit(e.target.value))}>
          <option value="default">Default ({limitLabel(state.routing.resetAfterMin).toLowerCase()})</option>
          {ROUTE_LIMITS.map((m) => (
            <option key={limitValue(m)} value={limitValue(m)}>
              {limitLabel(m)}
            </option>
          ))}
        </Select>
      </Field>
      <div className="row-actions">
        <Button busy={busy} disabled={!online || !route || policy.flood} onClick={() => void act(() => session.resetPath(contactKey))}>
          Forget route now
        </Button>
      </div>
      {error ? <p className="connect-error">{error}</p> : null}
    </Dialog>
  );
}

/** "just now", "12 min ago", "3 h ago". */
function since(ms: number, now: number): string {
  const text = ago(ms, now);
  if (text === "just now") return text;
  return now - ms < 7 * 86_400_000 ? `${text} ago` : `on ${text}`;
}
