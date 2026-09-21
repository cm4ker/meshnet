import { useState } from "react";
import { AdvType, NoReplyError, aclRoleName, type ContactRecord, type NodeStats } from "@meshnet/meshcore";
import { ago, batteryPercent, plural } from "../../lib/format.js";
import { clockDrift, hopsLabel, isAdmin } from "../../lib/nodes.js";
import { session, useSession } from "../../lib/session.js";
import { Button, IconButton } from "../../ui/Button.js";
import { Confirm } from "../../ui/Dialog.js";
import { Row, Section } from "../../ui/Field.js";
import { Readings } from "../ContactCard.js";
import { AlertIcon, CheckIcon, CopyIcon, LockIcon, RefreshIcon } from "../Icons.js";
import { Sparkline } from "./Sparkline.js";

/** Below this a single LiPo cell is close to the cut-off. */
const LOW_BATTERY_MV = 3600;
/** A node's clock this far off ours is worth setting. */
const DRIFT_WORTH_FIXING_S = 30;

export function Overview({ contact, onSignIn, onForget }: { contact: ContactRecord; onSignIn: () => void; onForget: () => void }) {
  const state = useSession();
  const key = contact.key;
  const login = state.logins[key];
  const admin = isAdmin(login);
  const online = state.status === "ready";
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<"reboot" | null>(null);

  const run = (name: string, action: () => Promise<string | void>) => async () => {
    setBusy(name);
    setError(null);
    setNote(null);
    try {
      const said = await action();
      if (said) setNote(said);
    } catch (e) {
      setError(e instanceof NoReplyError ? `${e.message}. The node may be out of range; try again.` : (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const cli = (command: string) => run(command, async () => `${contact.name}: ${await session.runCli(key, command)}`);
  const refresh = (name: string, action: () => Promise<unknown>) => (
    <Button size="sm" busy={busy === name} disabled={!online} onClick={run(name, async () => void (await action()))}>
      <RefreshIcon size={13} />
      Refresh
    </Button>
  );

  const status = state.statuses[key];
  const history = state.statusHistory[key] ?? [];
  const telemetry = state.telemetry[key];
  const owner = state.ownerInfo[key];
  const drift = clockDrift(login);
  const sensor = contact.type === AdvType.Sensor;

  return (
    <div className="card-scroll">
      {!login?.ok ? (
        <div className="banner-box">
          <LockIcon size={18} />
          <p>
            Not signed in. {sensor ? "A sensor" : contact.type === AdvType.Room ? "A room" : "A repeater"} answers only clients it knows, so sign in first; a
            blank password works if it already knows this radio.
          </p>
          <Button size="sm" variant="primary" onClick={onSignIn}>
            Sign in
          </Button>
        </div>
      ) : !admin ? (
        <div className="banner-box">
          <LockIcon size={18} />
          <p>
            Signed in as {login.role === null ? "a client" : aclRoleName(login.role)}. Status and telemetry are open to every client; settings, access and the
            console need the admin password.
          </p>
          <Button size="sm" variant="primary" onClick={onSignIn}>
            Sign in as admin
          </Button>
        </div>
      ) : null}

      {error ? <p className="connect-error">{error}</p> : null}
      {note ? <p className="muted small">{note}</p> : null}

      {sensor ? (
        <Section
          title="Readings"
          actions={
            <>
              <span className="muted small">{telemetry ? ago(telemetry.at) : "not asked yet"}</span>
              {refresh("telemetry", () => session.requestTelemetry(key))}
            </>
          }
        >
          {telemetry ? <Readings readings={telemetry.readings} /> : <p className="muted">Refresh asks the sensor for its readings once.</p>}
          <p className="field-hint">Alerts the sensor raises reach its admins as ordinary messages, in the chat with {contact.name || "it"}.</p>
        </Section>
      ) : (
        <Section
          title="Health"
          actions={
            <>
              <span className="muted small">{status ? ago(status.at) : "never"}</span>
              {refresh("status", () => session.requestStatus(key))}
            </>
          }
        >
          {status?.stats ? (
            <Health stats={status.stats} history={history} room={contact.type === AdvType.Room} />
          ) : status ? (
            <p className="muted">A status came back ({status.raw.length / 2} bytes) in a shape this client does not read.</p>
          ) : (
            <p className="muted">No status yet. Refresh asks the node once; every answer is kept for a week, so the trend lines fill in as you ask.</p>
          )}
        </Section>
      )}

      {!sensor && telemetry ? (
        <Section title={`Telemetry · ${ago(telemetry.at)}`}>
          <Readings readings={telemetry.readings} />
        </Section>
      ) : null}

      {drift !== null ? (
        <Section title="Clock">
          <div className="kv-grid">
            <Row label="Node time">
              <span className="mono">{new Date(Date.now() - drift * 1000).toLocaleTimeString()}</span>
            </Row>
            <Row label="Against this device">
              {Math.abs(drift) > DRIFT_WORTH_FIXING_S ? (
                <span className="pill warn">
                  <AlertIcon size={11} />
                  {Math.abs(drift)} s {drift > 0 ? "behind" : "ahead"}
                </span>
              ) : (
                <span className="pill ok">
                  <CheckIcon size={11} />
                  in sync
                </span>
              )}
            </Row>
          </div>
          <div className="row-actions wrap">
            <Button size="sm" variant={Math.abs(drift) > DRIFT_WORTH_FIXING_S ? "primary" : "default"} busy={busy === "clock sync"} disabled={!online || !admin} onClick={cli("clock sync")}>
              Sync clock
            </Button>
            <span className="field-hint">From the sign-in reply ({ago(login!.at)}). The node stamps its adverts with this clock.</span>
          </div>
        </Section>
      ) : null}

      <Section
        title="About"
        actions={
          contact.type === AdvType.Repeater && login?.ok ? (
            <Button size="sm" busy={busy === "owner"} disabled={!online} onClick={run("owner", async () => void (await session.requestOwnerInfo(key)))}>
              {owner ? "Ask again" : "Ask the node"}
            </Button>
          ) : undefined
        }
      >
        <div className="kv-grid">
          {owner ? (
            <>
              <Row label="Firmware">
                <span className="mono small">{owner.firmware}</span>
              </Row>
              <Row label="Owner">{owner.owner ? <span className="multiline">{owner.owner}</span> : <span className="muted">not set</span>}</Row>
            </>
          ) : contact.type === AdvType.Repeater ? (
            <Row label="Firmware and owner">
              <span className="muted">not asked yet</span>
            </Row>
          ) : null}
          {login?.firmwareLevel != null ? <Row label="Firmware level">{login.firmwareLevel}</Row> : null}
          <Row label="Route">{hopsLabel(contact)}</Row>
          <Row label="Public key">
            <code className="mono small">{contact.key.slice(0, 16)}…</code>
            <IconButton label="Copy key" onClick={() => void navigator.clipboard?.writeText(contact.key)}>
              <CopyIcon size={14} />
            </IconButton>
          </Row>
        </div>
        {contact.type === AdvType.Room ? <p className="field-hint">Rooms do not answer owner-info requests.</p> : null}
      </Section>

      {admin ? (
        <Section title="Actions">
          <div className="row-actions wrap">
            <Button busy={busy === "advert"} disabled={!online} onClick={cli("advert")}>
              Advert (flood)
            </Button>
            <Button busy={busy === "advert.zerohop"} disabled={!online} onClick={cli("advert.zerohop")}>
              Advert (zero hop)
            </Button>
            {!sensor ? (
              <Button busy={busy === "clear stats"} disabled={!online} onClick={cli("clear stats")}>
                Clear stats
              </Button>
            ) : null}
            {!sensor ? (
              <Button busy={busy === "telemetry"} disabled={!online} onClick={run("telemetry", async () => void (await session.requestTelemetry(key)))}>
                Read sensors
              </Button>
            ) : null}
            <Button variant="danger" disabled={!online} onClick={() => setAsk("reboot")}>
              Reboot
            </Button>
          </div>
          <p className="field-hint">Each is one console command over the air, and waits its turn in the queue.</p>
        </Section>
      ) : null}

      <Section title="Remove">
        <div className="row-actions">
          <Button variant="danger" onClick={onForget}>
            Forget this node
          </Button>
        </div>
        <p className="field-hint">Takes it out of this list with its saved password and status history. The contact stays.</p>
      </Section>

      <Confirm
        open={ask === "reboot"}
        title={`Reboot ${contact.name}?`}
        body={<p>The node goes off the air for a few seconds and forgets its neighbour list. It sends no reply, so the console will show none.</p>}
        confirmLabel="Reboot"
        danger
        onCancel={() => setAsk(null)}
        onConfirm={async () => {
          setAsk(null);
          await run("reboot", async () => {
            try {
              await session.runCli(key, "reboot");
            } catch (e) {
              if (!(e instanceof NoReplyError)) throw e;
            }
            return `${contact.name} was told to reboot.`;
          })();
        }}
      />
    </div>
  );
}

function Health({ stats, history, room }: { stats: NodeStats; history: { at: number; batteryMv: number; noiseFloor: number }[]; room: boolean }) {
  const batteries = history.map((s) => s.batteryMv / 1000);
  const noise = history.map((s) => s.noiseFloor);
  const times = history.map((s) => s.at);
  const low = stats.batteryMv > 0 && stats.batteryMv < LOW_BATTERY_MV;
  const drop = batteries.length > 1 ? batteries[0]! - batteries[batteries.length - 1]! : 0;
  return (
    <>
      <div className="stats">
        <div className="stat">
          <span className="stat-label">
            Battery
            {low ? (
              <span className="pill warn">
                <AlertIcon size={11} />
                Low
              </span>
            ) : null}
          </span>
          <span className="stat-value">
            {(stats.batteryMv / 1000).toFixed(2)}
            <small>V</small>
          </span>
          <span className="stat-sub">{drop > 0.05 ? `down ${drop.toFixed(2)} V over the readings` : `about ${batteryPercent(stats.batteryMv)}% for a LiPo cell`}</span>
          {batteries.length > 0 ? <Sparkline values={batteries} times={times} unit="V" digits={2} /> : null}
        </div>
        <div className="stat">
          <span className="stat-label">Noise floor</span>
          <span className="stat-value">
            {stats.noiseFloor}
            <small>dBm</small>
          </span>
          <span className="stat-sub">lower is quieter</span>
          {noise.length > 0 ? <Sparkline values={noise} times={times} unit="dBm" digits={0} /> : null}
        </div>
        <div className="stat">
          <span className="stat-label">Uptime</span>
          <span className="stat-value">{duration(stats.upTimeSecs)}</span>
        </div>
        {room ? (
          <div className="stat">
            <span className="stat-label">Posts</span>
            <span className="stat-value">
              {stats.posted ?? "—"}
              <small>stored</small>
            </span>
            <span className="stat-sub">{stats.postPushes !== null ? `${plural(stats.postPushes, "push", "pushes")} to members` : ""}</span>
          </div>
        ) : (
          <div className="stat">
            <span className="stat-label">Air time</span>
            <span className="stat-value">
              {stats.upTimeSecs > 0 ? ((stats.airTimeSecs / stats.upTimeSecs) * 100).toFixed(1) : "—"}
              <small>% tx</small>
            </span>
            <span className="stat-sub">
              tx {duration(stats.airTimeSecs)}
              {stats.rxAirTimeSecs !== null ? ` · rx ${duration(stats.rxAirTimeSecs)}` : ""}
            </span>
          </div>
        )}
      </div>
      <div className="kv-grid">
        <Row label="Last RSSI / SNR">
          {stats.lastRssi} dBm / {stats.lastSnr.toFixed(2)} dB
        </Row>
        <Row label="Packets">
          {n(stats.packetsRecv)} in · {n(stats.packetsSent)} out
          {stats.recvErrors !== null ? ` · ${n(stats.recvErrors)} errors` : ""}
        </Row>
        <Row label="Flood / direct">
          in {n(stats.recvFlood)} / {n(stats.recvDirect)} · out {n(stats.sentFlood)} / {n(stats.sentDirect)}
        </Row>
        <Row label="Duplicates dropped">
          {n(stats.floodDups)} flood · {n(stats.directDups)} direct
        </Row>
        <Row label="Send queue">{stats.txQueueLen === 0 ? "empty" : plural(stats.txQueueLen, "packet")}</Row>
      </div>
    </>
  );
}

function n(value: number): string {
  return value.toLocaleString();
}

function duration(secs: number): string {
  if (secs >= 86_400) return `${Math.floor(secs / 86_400)} d ${Math.floor((secs % 86_400) / 3600)} h`;
  if (secs >= 3600) return `${Math.floor(secs / 3600)} h ${Math.floor((secs % 3600) / 60)} min`;
  return `${Math.floor(secs / 60)} min`;
}
