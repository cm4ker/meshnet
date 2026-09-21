import { useState } from "react";
import { AdvType, NoReplyError, type ContactRecord, type NodeStats } from "@meshnet/meshcore";
import { ago, agoPhrase, batteryPercent, plural } from "../../lib/format.js";
import { clockDrift, isAdmin } from "../../lib/nodes.js";
import { session, useSession } from "../../lib/session.js";
import { toast } from "../../lib/toast.js";
import { ActionRow, Block, Group, InfoRow } from "../../ui/List.js";
import { AlertIcon, CheckIcon } from "../Icons.js";
import { Readings } from "../Readings.js";
import { Sparkline } from "./Sparkline.js";

/** Below this a single LiPo cell is close to the cut-off. */
export const LOW_BATTERY_MV = 3600;
/** A node's clock this far off ours is worth setting. */
const DRIFT_WORTH_FIXING_S = 30;

function said(error: unknown): string {
  return error instanceof NoReplyError ? `${error.message}. The node may be out of range; try again.` : (error as Error).message;
}

/**
 * How a repeater, room or sensor is doing, from the last answers it gave: a
 * repeater's or room's health with a week's trend, a sensor's readings, and
 * its clock against ours. Every refresh is one request on the air.
 */
export function NodeStatus({ contact }: { contact: ContactRecord }) {
  const state = useSession();
  const key = contact.key;
  const online = state.status === "ready";
  const login = state.logins[key];
  const admin = isAdmin(login);
  const [busy, setBusy] = useState<string | null>(null);

  const run = (name: string, action: () => Promise<unknown>, done?: string) => async () => {
    setBusy(name);
    try {
      await action();
      if (done) toast(done);
    } catch (e) {
      toast(said(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const status = state.statuses[key];
  const history = state.statusHistory[key] ?? [];
  const telemetry = state.telemetry[key];
  const drift = clockDrift(login);
  const sensor = contact.type === AdvType.Sensor;

  return (
    <>
      {sensor ? (
        <Group title={`Readings · ${telemetry ? ago(telemetry.at) : "not asked yet"}`} note={`Alerts the sensor raises reach its admins as messages, in the chat with ${contact.name || "it"}.`}>
          {telemetry ? <Readings readings={telemetry.readings} /> : null}
          <ActionRow label="Ask for readings" air busy={busy === "telemetry"} disabled={!online} onClick={run("telemetry", () => session.requestTelemetry(key))} />
        </Group>
      ) : (
        <Group title={`Status · ${status ? ago(status.at) : "never asked"}`} note={status ? undefined : "Every answer is kept for a week, so the trend lines fill in as you ask."}>
          {status?.stats ? (
            <Block>
              <Health stats={status.stats} history={history} room={contact.type === AdvType.Room} />
            </Block>
          ) : status ? (
            <InfoRow label="Answer">{status.raw.length / 2} bytes this client does not read</InfoRow>
          ) : null}
          <ActionRow label="Ask for status" air busy={busy === "status"} disabled={!online} onClick={run("status", () => session.requestStatus(key))} />
        </Group>
      )}

      {!sensor && telemetry ? (
        <Group title={`Telemetry · ${ago(telemetry.at)}`}>
          <Readings readings={telemetry.readings} />
        </Group>
      ) : null}

      {drift !== null && Math.abs(drift) > DRIFT_WORTH_FIXING_S ? (
        <Group>
          <InfoRow label="Clock" hint={`From the sign-in ${agoPhrase(login!.at)}. The node stamps its adverts with it.`}>
            <span className="pill warn">
              <AlertIcon size={11} />
              {Math.abs(drift)} s {drift > 0 ? "behind" : "ahead"}
            </span>
          </InfoRow>
          {admin ? <ActionRow label="Set its clock from this radio" air busy={busy === "clock"} disabled={!online} onClick={run("clock", () => session.runCli(key, "clock sync"), "Clock set")} /> : null}
        </Group>
      ) : drift !== null ? (
        <Group>
          <InfoRow label="Clock">
            <span className="pill ok">
              <CheckIcon size={11} />
              in sync
            </span>
          </InfoRow>
        </Group>
      ) : null}
    </>
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
      <details className="more">
        <summary>Packets and signal</summary>
        <div className="kv-grid">
          <Kv label="Last RSSI / SNR">
            {stats.lastRssi} dBm / {stats.lastSnr.toFixed(2)} dB
          </Kv>
          <Kv label="Packets">
            {n(stats.packetsRecv)} in · {n(stats.packetsSent)} out
            {stats.recvErrors !== null ? ` · ${n(stats.recvErrors)} errors` : ""}
          </Kv>
          <Kv label="Flood / direct">
            in {n(stats.recvFlood)} / {n(stats.recvDirect)} · out {n(stats.sentFlood)} / {n(stats.sentDirect)}
          </Kv>
          <Kv label="Duplicates dropped">
            {n(stats.floodDups)} flood · {n(stats.directDups)} direct
          </Kv>
          <Kv label="Send queue">{stats.txQueueLen === 0 ? "empty" : plural(stats.txQueueLen, "packet")}</Kv>
        </div>
      </details>
    </>
  );
}

function Kv({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="kv">
      <span className="kv-label">{label}</span>
      <span className="kv-value">{children}</span>
    </div>
  );
}

function n(value: number): string {
  return value.toLocaleString();
}

export function duration(secs: number): string {
  if (secs >= 86_400) return `${Math.floor(secs / 86_400)} d ${Math.floor((secs % 86_400) / 3600)} h`;
  if (secs >= 3600) return `${Math.floor(secs / 3600)} h ${Math.floor((secs % 3600) / 60)} min`;
  return `${Math.floor(secs / 60)} min`;
}
