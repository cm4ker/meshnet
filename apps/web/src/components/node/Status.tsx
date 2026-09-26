import { useState } from "react";
import { AdvType, type ContactRecord, type NodeStats } from "@meshnet/meshcore";
import { errorText } from "../../i18n/errors.js";
import { locale, t } from "../../i18n/index.js";
import { ago, agoPhrase, batteryPercent } from "../../lib/format.js";
import { showOnMap } from "../../lib/nav.js";
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
      toast(errorText(e), "error");
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
        <Group
          title={t("node.status.readings", { time: telemetry ? ago(telemetry.at) : t("node.notAskedYet") })}
          note={contact.name ? t("node.status.alerts", { name: contact.name }) : t("node.status.alertsUnnamed")}
        >
          {telemetry ? <Readings readings={telemetry.readings} from={state.self} onMap={() => showOnMap(key, true)} /> : null}
          <ActionRow label={t("node.status.askReadings")} air busy={busy === "telemetry"} disabled={!online} onClick={run("telemetry", () => session.requestTelemetry(key))} />
        </Group>
      ) : (
        <Group title={t("node.status.title", { time: status ? ago(status.at) : t("node.status.neverAsked") })} note={status ? undefined : t("node.status.keptForWeek")}>
          {status?.stats ? (
            <Block>
              <Health stats={status.stats} history={history} room={contact.type === AdvType.Room} />
            </Block>
          ) : status ? (
            <InfoRow label={t("node.status.answer")}>{t("node.status.unreadBytes", { count: status.raw.length / 2 })}</InfoRow>
          ) : null}
          <ActionRow label={t("node.status.askStatus")} air busy={busy === "status"} disabled={!online} onClick={run("status", () => session.requestStatus(key))} />
        </Group>
      )}

      {!sensor && telemetry ? (
        <Group title={t("node.status.telemetry", { time: ago(telemetry.at) })}>
          <Readings readings={telemetry.readings} from={state.self} onMap={() => showOnMap(key, true)} />
        </Group>
      ) : null}

      {drift !== null && Math.abs(drift) > DRIFT_WORTH_FIXING_S ? (
        <Group>
          <InfoRow label={t("node.status.clock")} hint={t("node.status.clockHint", { time: agoPhrase(login!.at) })}>
            <span className="pill warn">
              <AlertIcon size={11} />
              {t(drift > 0 ? "node.status.behind" : "node.status.ahead", { seconds: Math.abs(drift) })}
            </span>
          </InfoRow>
          {admin ? (
            <ActionRow
              label={t("node.status.setClock")}
              air
              busy={busy === "clock"}
              disabled={!online}
              onClick={run("clock", () => session.runCli(key, "clock sync"), t("node.status.clockSet"))}
            />
          ) : null}
        </Group>
      ) : drift !== null ? (
        <Group>
          <InfoRow label={t("node.status.clock")}>
            <span className="pill ok">
              <CheckIcon size={11} />
              {t("node.status.inSync")}
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
  const volt = t("node.unit.volt");
  const dbm = t("node.unit.dbm");
  return (
    <>
      <div className="stats">
        <div className="stat">
          <span className="stat-label">
            {t("node.status.battery")}
            {low ? (
              <span className="pill warn">
                <AlertIcon size={11} />
                {t("node.status.low")}
              </span>
            ) : null}
          </span>
          <span className="stat-value">
            {(stats.batteryMv / 1000).toFixed(2)}
            <small>{volt}</small>
          </span>
          <span className="stat-sub">
            {drop > 0.05 ? t("node.status.batteryDown", { volts: drop.toFixed(2) }) : t("node.status.batteryAbout", { percent: batteryPercent(stats.batteryMv) })}
          </span>
          {batteries.length > 0 ? <Sparkline values={batteries} times={times} unit={volt} digits={2} /> : null}
        </div>
        <div className="stat">
          <span className="stat-label">{t("node.status.noiseFloor")}</span>
          <span className="stat-value">
            {stats.noiseFloor}
            <small>{dbm}</small>
          </span>
          <span className="stat-sub">{t("node.status.quieter")}</span>
          {noise.length > 0 ? <Sparkline values={noise} times={times} unit={dbm} digits={0} /> : null}
        </div>
        <div className="stat">
          <span className="stat-label">{t("node.status.uptime")}</span>
          <span className="stat-value">{duration(stats.upTimeSecs)}</span>
        </div>
        {room ? (
          <div className="stat">
            <span className="stat-label">{t("node.status.posts")}</span>
            <span className="stat-value">
              {stats.posted ?? "—"}
              <small>{t("node.status.stored")}</small>
            </span>
            <span className="stat-sub">{stats.postPushes !== null ? t("node.status.pushes", { count: stats.postPushes }) : ""}</span>
          </div>
        ) : (
          <div className="stat">
            <span className="stat-label">{t("node.status.airTime")}</span>
            <span className="stat-value">
              {stats.upTimeSecs > 0 ? ((stats.airTimeSecs / stats.upTimeSecs) * 100).toFixed(1) : "—"}
              <small>{t("node.status.txPercent")}</small>
            </span>
            <span className="stat-sub">
              {stats.rxAirTimeSecs !== null
                ? t("node.status.txRx", { tx: duration(stats.airTimeSecs), rx: duration(stats.rxAirTimeSecs) })
                : t("node.status.tx", { time: duration(stats.airTimeSecs) })}
            </span>
          </div>
        )}
      </div>
      <details className="more">
        <summary>{t("node.status.packetsAndSignal")}</summary>
        <div className="kv-grid">
          <Kv label={t("node.status.lastSignal")}>{t("node.status.signal", { rssi: stats.lastRssi, snr: stats.lastSnr.toFixed(2) })}</Kv>
          <Kv label={t("node.status.packets")}>
            {stats.recvErrors !== null
              ? t("node.status.inOutErrors", { in: n(stats.packetsRecv), out: n(stats.packetsSent), errors: n(stats.recvErrors) })
              : t("node.status.inOut", { in: n(stats.packetsRecv), out: n(stats.packetsSent) })}
          </Kv>
          <Kv label={t("node.status.floodDirect")}>
            {t("node.status.floodDirectValue", { inFlood: n(stats.recvFlood), inDirect: n(stats.recvDirect), outFlood: n(stats.sentFlood), outDirect: n(stats.sentDirect) })}
          </Kv>
          <Kv label={t("node.status.duplicates")}>{t("node.status.duplicatesValue", { flood: n(stats.floodDups), direct: n(stats.directDups) })}</Kv>
          <Kv label={t("node.status.sendQueue")}>{stats.txQueueLen === 0 ? t("node.status.empty") : t("node.status.queuePackets", { count: stats.txQueueLen })}</Kv>
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
  return value.toLocaleString(locale());
}

export function duration(secs: number): string {
  if (secs >= 86_400) return t("node.duration.days", { days: Math.floor(secs / 86_400), hours: Math.floor((secs % 86_400) / 3600) });
  if (secs >= 3600) return t("node.duration.hours", { hours: Math.floor(secs / 3600), minutes: Math.floor((secs % 3600) / 60) });
  return t("node.duration.minutes", { minutes: Math.floor(secs / 60) });
}
