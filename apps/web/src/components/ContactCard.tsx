import { useState } from "react";
import { AdvType, contactHops, contactTypeName, isFavourite, pathByteLength, type LppReading, type RepeaterStats } from "@meshnet/meshcore";
import { contactConversation } from "../lib/conversations.js";
import { ago, battery } from "../lib/format.js";
import { openConversation } from "../lib/nav.js";
import { session, useSession } from "../lib/session.js";
import { Button, IconButton } from "../ui/Button.js";
import { Confirm, Prompt } from "../ui/Dialog.js";
import { Row, Section } from "../ui/Field.js";
import { Avatar } from "./Avatar.js";
import { BackIcon, CopyIcon, StarFilledIcon, StarIcon } from "./Icons.js";

export function ContactCard({ contactKey, onClose }: { contactKey: string; onClose: () => void }) {
  const state = useSession();
  const contact = state.contacts[contactKey];
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<"remove" | "login" | "rename" | null>(null);
  const online = state.status === "ready";

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
  const infra = contact.type === AdvType.Repeater || contact.type === AdvType.Room;
  const login = state.logins[contact.key];
  const status = state.statuses[contact.key];
  const telemetry = state.telemetry[contact.key];

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
          <Row label="Route">{hops === null ? "unknown, messages flood" : hops === 0 ? "direct" : `${hops} hop${hops === 1 ? "" : "s"} (${contact.outPath.slice(0, pathByteLength(contact.outPathLen) * 2)})`}</Row>
          {contact.lat || contact.lon ? (
            <Row label="Position">
              <a href={`https://www.openstreetmap.org/?mlat=${contact.lat}&mlon=${contact.lon}#map=14/${contact.lat}/${contact.lon}`} target="_blank" rel="noreferrer">
                {contact.lat.toFixed(5)}, {contact.lon.toFixed(5)}
              </a>
            </Row>
          ) : null}
        </Section>

        <Section title="Mesh">
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

        {infra ? (
          <Section title={contact.type === AdvType.Repeater ? "Repeater" : "Room"}>
            <Row label="Login">
              {login ? (login.ok ? `signed in${login.permissions & 1 ? " as admin" : ""} · ${ago(login.at)}` : `refused · ${ago(login.at)}`) : "not signed in"}
            </Row>
            <div className="row-actions wrap">
              <Button variant="primary" disabled={!online} onClick={() => setAsk("login")}>
                Sign in
              </Button>
              {login?.ok ? (
                <Button busy={busy === "logout"} onClick={run("logout", () => session.logout(contact.key))}>
                  Sign out
                </Button>
              ) : null}
              <Button busy={busy === "status"} disabled={!online} onClick={run("status", () => session.requestStatus(contact.key))}>
                Request status
              </Button>
            </div>
            {status?.stats ? <Stats stats={status.stats} at={status.at} /> : status ? <p className="muted small">Status received ({status.raw.length / 2} bytes), in a shape this client does not read.</p> : null}
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
        open={ask === "login"}
        title={`Sign in to ${contact.name}`}
        label="Password"
        type="password"
        submitLabel="Sign in"
        onCancel={() => setAsk(null)}
        onSubmit={async (password) => {
          await session.login(contact.key, password);
          setAsk(null);
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

function Stats({ stats, at }: { stats: RepeaterStats; at: number }) {
  const up = stats.upTimeSecs;
  const uptime = up >= 86400 ? `${Math.floor(up / 86400)} d ${Math.floor((up % 86400) / 3600)} h` : `${Math.floor(up / 3600)} h ${Math.floor((up % 3600) / 60)} min`;
  return (
    <div className="kv-grid">
      <Row label="Received">{ago(at)}</Row>
      <Row label="Battery">{battery(stats.batteryMv)}</Row>
      <Row label="Uptime">{uptime}</Row>
      <Row label="Noise floor">{stats.noiseFloor} dBm</Row>
      <Row label="Last RSSI / SNR">
        {stats.lastRssi} dBm / {stats.lastSnr.toFixed(1)} dB
      </Row>
      <Row label="Packets">
        {stats.packetsRecv} in · {stats.packetsSent} out · {stats.recvErrors} errors
      </Row>
      <Row label="Flood / direct">
        {stats.recvFlood}/{stats.recvDirect} in · {stats.sentFlood}/{stats.sentDirect} out
      </Row>
      <Row label="Air time">
        tx {Math.round(stats.airTimeSecs / 60)} min · rx {Math.round(stats.rxAirTimeSecs / 60)} min
      </Row>
      <Row label="Queue">{stats.txQueueLen}</Row>
      <Row label="Duplicates">
        {stats.floodDups} flood · {stats.directDups} direct
      </Row>
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
