import { useState } from "react";
import { AdvType, contactHops, contactTypeName, isConversationType, isFavourite, isNodeType, pathByteLength, type LppReading } from "@meshnet/meshcore";
import { contactConversation } from "../lib/conversations.js";
import { ago } from "../lib/format.js";
import { openConversation, openNode } from "../lib/nav.js";
import { inMinutes, limitLabel, limitValue, parseLimit, ROUTE_LIMITS, useNow } from "../lib/routes.js";
import { session, useSession } from "../lib/session.js";
import { Button, IconButton } from "../ui/Button.js";
import { Confirm, Prompt } from "../ui/Dialog.js";
import { Field, Row, Section, Select, Toggle } from "../ui/Field.js";
import { Avatar } from "./Avatar.js";
import { BackIcon, CopyIcon, StarFilledIcon, StarIcon } from "./Icons.js";

export function ContactCard({ contactKey, onClose }: { contactKey: string; onClose: () => void }) {
  const state = useSession();
  const contact = state.contacts[contactKey];
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<"remove" | "rename" | null>(null);
  const online = state.status === "ready";
  const now = useNow();

  if (!contact) {
    return (
      <div className="card">
        <header className="chat-head">
          <IconButton label="Back" onClick={onClose}>
            <BackIcon size={18} />
          </IconButton>
          <span className="row-title">Contact</span>
        </header>
        <div className="empty muted">This contact is gone.</div>
      </div>
    );
  }

  const run = (name: string, action: () => Promise<unknown>) => async () => {
    setBusy(name);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const hops = contactHops(contact);
  const node = isNodeType(contact.type);
  const telemetry = state.telemetry[contact.key];
  const routed = isConversationType(contact.type);
  const policy = session.routePolicy(contact.key);
  const expires = session.routeExpiresAt(contact.key);

  return (
    <div className="card">
      <header className="chat-head">
        <IconButton label="Back" onClick={onClose}>
          <BackIcon size={18} />
        </IconButton>
        <div className="chat-title">
          <span className="row-title">{contact.name || contact.prefix}</span>
          <span className="muted small">{contactTypeName(contact.type)}</span>
        </div>
        <IconButton label={isFavourite(contact) ? "Unstar" : "Star"} disabled={!online} onClick={run("star", () => session.setFavourite(contact.key, !isFavourite(contact)))}>
          {isFavourite(contact) ? <StarFilledIcon size={18} className="star" /> : <StarIcon size={18} />}
        </IconButton>
      </header>

      <div className="card-scroll">
        <div className="card-hero">
          <Avatar name={contact.name || contact.prefix} type={contact.type} size={56} />
          <div className="row-actions">
            {contact.type !== AdvType.Repeater ? (
              <Button variant="primary" onClick={() => openConversation(contactConversation(contact.key))}>
                Message
              </Button>
            ) : null}
            <Button onClick={() => setAsk("rename")} disabled={!online}>
              Rename
            </Button>
          </div>
        </div>

        {error ? <p className="connect-error">{error}</p> : null}

        <Section title="Details">
          <Row label="Public key">
            <code className="mono small">{contact.key.slice(0, 16)}…</code>
            <IconButton label="Copy key" onClick={() => void navigator.clipboard?.writeText(contact.key)}>
              <CopyIcon size={14} />
            </IconButton>
          </Row>
          <Row label="Last heard">{ago(Math.max(contact.lastHeardAt ?? 0, contact.lastAdvert * 1000) || null)}</Row>
          <Row label="Route">
            {routed && policy.flood
              ? "flood, pinned"
              : hops === null
                ? "unknown, messages flood"
                : hops === 0
                  ? "direct"
                  : `${hops} hop${hops === 1 ? "" : "s"} (${contact.outPath.slice(0, pathByteLength(contact.outPathLen) * 2)})`}
          </Row>
          {expires !== null ? <Row label="Route dropped">{inMinutes(expires - now)}</Row> : null}
          {contact.lat || contact.lon ? (
            <Row label="Position">
              <a href={`https://www.openstreetmap.org/?mlat=${contact.lat}&mlon=${contact.lon}#map=14/${contact.lat}/${contact.lon}`} target="_blank" rel="noreferrer">
                {contact.lat.toFixed(5)}, {contact.lon.toFixed(5)}
              </a>
            </Row>
          ) : null}
        </Section>

        <Section title="Mesh">
          {routed ? (
            <>
              <Toggle
                label="Always flood"
                hint="Messages to this contact ignore learned routes. Handy on the move; costs the mesh two floods a message."
                checked={policy.flood}
                onChange={(v) => void run("flood", () => session.setFloodPinned(contact.key, v))()}
              />
              <Field label="Drop the learned route after">
                <Select
                  value={limitValue(state.routing.contacts[contact.key]?.resetAfterMin)}
                  disabled={policy.flood}
                  onChange={(e) => session.setRouteReset(contact.key, parseLimit(e.target.value))}
                >
                  <option value="default">Default ({limitLabel(state.routing.resetAfterMin).toLowerCase()})</option>
                  {ROUTE_LIMITS.map((m) => (
                    <option key={limitValue(m)} value={limitValue(m)}>
                      {limitLabel(m)}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          ) : null}
          <div className="row-actions wrap">
            <Button busy={busy === "path"} disabled={!online} onClick={run("path", () => session.resetPath(contact.key))}>
              Forget route
            </Button>
            <Button busy={busy === "discover"} disabled={!online} onClick={run("discover", () => session.discoverPath(contact.key))}>
              Discover path
            </Button>
            <Button busy={busy === "share"} disabled={!online} onClick={run("share", () => session.shareContact(contact.key))}>
              Share on air
            </Button>
            <Button busy={busy === "telemetry"} disabled={!online} onClick={run("telemetry", () => session.requestTelemetry(contact.key))}>
              Request telemetry
            </Button>
          </div>
          <p className="muted small">Discovery and telemetry answer through the log and the readings below, when the radio hears back.</p>
        </Section>

        {node ? (
          <Section title={contact.type === AdvType.Repeater ? "Repeater" : contact.type === AdvType.Room ? "Room" : "Sensor"}>
            <div className="row-actions wrap">
              <Button variant="primary" onClick={() => openNode(contact.key)}>
                Manage in Nodes
              </Button>
            </div>
            <p className="muted small">Sign-in, status, neighbours, settings and the console are in the Nodes section.</p>
          </Section>
        ) : null}

        {telemetry ? (
          <Section title={`Telemetry · ${ago(telemetry.at)}`}>
            <Readings readings={telemetry.readings} />
          </Section>
        ) : null}

        <Section title="Remove">
          <Button variant="danger" disabled={!online} onClick={() => setAsk("remove")}>
            Remove contact
          </Button>
          <p className="muted small">The radio forgets it; its messages stay here until the conversation is deleted.</p>
        </Section>
      </div>

      <Confirm
        open={ask === "remove"}
        title="Remove contact?"
        body={<p>{contact.name || contact.prefix} will be removed from the radio. It comes back on its next advert if auto-add is on.</p>}
        confirmLabel="Remove"
        danger
        onCancel={() => setAsk(null)}
        onConfirm={async () => {
          await session.removeContact(contact.key);
          setAsk(null);
          onClose();
        }}
      />
      <Prompt
        open={ask === "rename"}
        title="Rename contact"
        label="Name"
        initial={contact.name}
        submitLabel="Save"
        onCancel={() => setAsk(null)}
        onSubmit={async (name) => {
          if (name.trim()) await session.renameContact(contact.key, name.trim());
          setAsk(null);
        }}
      />
    </div>
  );
}

export function Readings({ readings }: { readings: LppReading[] }) {
  if (readings.length === 0) return <p className="muted small">No readings.</p>;
  return (
    <div className="kv-grid">
      {readings.map((r, i) => (
        <Row key={i} label={`${label(r)} · ch ${r.channel}`}>
          {value(r)}
        </Row>
      ))}
    </div>
  );
}

function label(r: LppReading): string {
  return r.type.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

function value(r: LppReading): string {
  switch (r.type) {
    case "voltage":
      return `${r.volts.toFixed(2)} V`;
    case "temperature":
      return `${r.celsius.toFixed(1)} °C`;
    case "humidity":
      return `${r.percent.toFixed(1)} %`;
    case "barometer":
      return `${r.hpa.toFixed(1)} hPa`;
    case "current":
      return `${r.amps.toFixed(3)} A`;
    case "power":
      return `${r.watts} W`;
    case "energy":
      return `${r.kwh.toFixed(3)} kWh`;
    case "luminosity":
      return `${r.lux} lx`;
    case "altitude":
      return `${r.meters} m`;
    case "distance":
      return `${r.meters.toFixed(3)} m`;
    case "concentration":
      return `${r.ppm} ppm`;
    case "direction":
      return `${r.degrees}°`;
    case "frequency":
      return `${r.hz} Hz`;
    case "percentage":
      return `${r.percent} %`;
    case "gps":
      return `${r.lat.toFixed(4)}, ${r.lon.toFixed(4)} · ${r.alt.toFixed(0)} m`;
    case "accelerometer":
    case "gyrometer":
      return `${r.x}, ${r.y}, ${r.z}`;
    case "colour":
      return `rgb(${r.r}, ${r.g}, ${r.b})`;
    case "unixTime":
      return new Date(r.seconds * 1000).toLocaleString();
    case "unknown":
      return `type ${r.code}`;
    default:
      return String((r as { value: number }).value);
  }
}
