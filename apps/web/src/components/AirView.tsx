/**
 * Settings › On the air: every packet the radio hears, whoever it is for, and
 * three numbers on top: its noise floor, how busy the channel was over the
 * last minute, how many packets that was. Listening only; a tap on a packet
 * says what it was.
 */

import { PayloadType, type HeardPacket, type SessionState } from "@meshnet/meshcore";
import { useEffect, useState } from "react";
import { locale, t } from "../i18n/index.js";
import { typeKind, typeName, useAir } from "../lib/air.js";
import { airtimeMs } from "../lib/composer.js";
import { nameOfHash } from "../lib/echoes.js";
import { formatDbm, formatSnr } from "../lib/los.js";
import { useSession } from "../lib/session.js";
import { ChevronDownIcon } from "./Icons.js";

type Shown = HeardPacket & { id: number };

/** Who a packet is about, as far as its first bytes say without the keys to open it. */
function about(p: Shown, state: SessionState): string {
  const packet = p.packet;
  if (!packet) return t("radio.air.notPacket");
  const pay = packet.payload;
  const hex = (b: number | undefined) => (b === undefined ? "??" : b.toString(16).padStart(2, "0"));
  const mine = (b: number | undefined) => !!state.self?.key.startsWith(hex(b));
  const who = (b: number | undefined) => {
    const h = hex(b);
    if (mine(b)) return t("radio.air.you");
    return nameOfHash(h, state.contacts) ?? h;
  };
  switch (packet.payloadType) {
    case PayloadType.Advert: {
      const key = Array.from(pay.subarray(0, 32), (b) => b.toString(16).padStart(2, "0")).join("");
      return state.contacts[key]?.name || t("radio.air.newNode", { key: key.slice(0, 8) });
    }
    case PayloadType.GroupText:
    case PayloadType.GroupData:
      return t("radio.air.channelMessage");
    case PayloadType.TxtMsg:
    case PayloadType.Req:
    case PayloadType.Response:
    case PayloadType.Path:
      return `${who(pay[1])} → ${who(pay[0])}`;
    case PayloadType.AnonReq:
      return mine(pay[0]) ? t("radio.air.toYou") : t("radio.air.to", { who: who(pay[0]) });
    case PayloadType.Ack:
      return t("radio.air.ack");
    case PayloadType.Trace:
      return t("radio.air.someonesPing");
    case PayloadType.Control:
      return (pay[0] ?? 0) >= 0x90 ? t("radio.air.whoHearsAnswer") : t("radio.air.whoHears");
    default:
      return "";
  }
}

function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return <svg className="spark" viewBox="0 0 100 18" aria-hidden="true" />;
  const lo = Math.min(...values) - 1;
  const hi = Math.max(...values) + 1;
  const points = values.map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(1)},${(17 - ((v - lo) / (hi - lo)) * 15).toFixed(1)}`);
  return (
    <svg className="spark" viewBox="0 0 100 18" preserveAspectRatio="none" aria-hidden="true">
      <polygon className="spark-area" points={`0,18 ${points.join(" ")} 100,18`} />
      <polyline className="spark-line" points={points.join(" ")} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function AirView() {
  const state = useSession();
  const air = useAir();
  const [open, setOpen] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const self = state.self;
  const minute = air.packets.filter((p) => now - p.at <= 60_000);
  const busy = self ? (minute.reduce((s, p) => s + airtimeMs(p.size, self), 0) / 60_000) * 100 : null;
  const perTen = Array.from({ length: 12 }, (_, i) => {
    const end = now - (11 - i) * 10_000;
    return air.packets.filter((p) => p.at > end - 10_000 && p.at <= end).length;
  });

  return (
    <div className="screen-scroll air">
      <div className="air-tiles">
        <div className="air-tile">
          <small>{t("radio.air.noiseFloor")}</small>
          <b className="mono">{air.stats ? formatDbm(air.stats.noiseFloor) : "—"}</b>
          <Spark values={air.noise} />
        </div>
        <div className="air-tile">
          <small>{t("radio.air.channelBusy")}</small>
          <b className="mono">{busy === null ? "—" : `${busy.toFixed(1)}%`}</b>
          <Spark values={perTen} />
        </div>
        <div className="air-tile">
          <small>{t("radio.air.heardMinute")}</small>
          <b className="mono">{minute.length}</b>
          <Spark values={perTen} />
        </div>
      </div>
      <p className="air-note muted">{t("radio.air.note")}</p>
      {air.packets.length === 0 ? <div className="empty muted">{t("radio.air.nothing")}</div> : null}
      <ul className="air-list" role="list">
        {air.packets.slice(0, 200).map((p) => {
          const type = p.packet ? p.packet.payloadType : -1;
          const shown = open === p.id;
          return (
            <li key={p.id}>
              <button type="button" className={["air-row", shown ? "open" : ""].join(" ")} aria-expanded={shown} onClick={() => setOpen(shown ? null : p.id)}>
                <span className={`air-type ${typeKind(type)}`}>{p.packet ? typeName(type) : "?"}</span>
                <span className="air-about">{about(p, state)}</span>
                <span className="air-snr mono">{t("radio.air.db", { value: formatSnr(p.snr) })}</span>
                <ChevronDownIcon size={14} className="air-chev" />
              </button>
              {shown && p.packet ? (
                <dl className="air-detail">
                  <dt>{t("radio.air.heard")}</dt>
                  <dd>
                    {new Date(p.at).toLocaleTimeString(locale())} · {t("radio.air.db", { value: formatSnr(p.snr) })} · {formatDbm(p.rssi)}
                  </dd>
                  <dt>{t("radio.air.route")}</dt>
                  <dd>{p.packet.flood ? t("radio.air.flood") : t("radio.air.direct")}</dd>
                  <dt>{t("radio.air.through")}</dt>
                  <dd>{p.packet.path.length ? p.packet.path.map((h) => nameOfHash(h, state.contacts) ?? h).join(" › ") : t("radio.air.nobody")}</dd>
                  <dt>{t("radio.air.size")}</dt>
                  <dd>{self ? t("radio.air.bytesAirtime", { size: p.size, ms: Math.round(airtimeMs(p.size, self)) }) : t("radio.air.bytes", { size: p.size })}</dd>
                </dl>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
