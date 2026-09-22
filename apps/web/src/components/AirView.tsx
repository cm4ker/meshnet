/**
 * Radio › On the air: every packet the radio hears, whoever it is for, and
 * three numbers on top: its noise floor, how busy the channel was over the
 * last minute, how many packets that was. Listening only; a tap on a packet
 * says what it was.
 */

import { PayloadType, type HeardPacket, type SessionState } from "@meshnet/meshcore";
import { useEffect, useState } from "react";
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
  if (!packet) return "not a packet";
  const pay = packet.payload;
  const hex = (b: number | undefined) => (b === undefined ? "??" : b.toString(16).padStart(2, "0"));
  const who = (b: number | undefined) => {
    const h = hex(b);
    if (state.self?.key.startsWith(h)) return "you";
    return nameOfHash(h, state.contacts) ?? h;
  };
  switch (packet.payloadType) {
    case PayloadType.Advert: {
      const key = Array.from(pay.subarray(0, 32), (b) => b.toString(16).padStart(2, "0")).join("");
      return state.contacts[key]?.name || `new node ${key.slice(0, 8)}`;
    }
    case PayloadType.GroupText:
    case PayloadType.GroupData:
      return "channel message";
    case PayloadType.TxtMsg:
    case PayloadType.Req:
    case PayloadType.Response:
    case PayloadType.Path:
      return `${who(pay[1])} → ${who(pay[0])}`;
    case PayloadType.AnonReq:
      return `to ${who(pay[0])}`;
    case PayloadType.Ack:
      return "acknowledgement";
    case PayloadType.Trace:
      return "someone's ping";
    case PayloadType.Control:
      return (pay[0] ?? 0) >= 0x90 ? "answer to who hears" : "who hears me?";
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
          <small>Noise floor</small>
          <b className="mono">{air.stats ? formatDbm(air.stats.noiseFloor) : "—"}</b>
          <Spark values={air.noise} />
        </div>
        <div className="air-tile">
          <small>Channel busy</small>
          <b className="mono">{busy === null ? "—" : `${busy.toFixed(1)}%`}</b>
          <Spark values={perTen} />
        </div>
        <div className="air-tile">
          <small>Heard · 1 min</small>
          <b className="mono">{minute.length}</b>
          <Spark values={perTen} />
        </div>
      </div>
      <p className="air-note muted">Listening only: nothing is sent. What the radio could not decode is not here.</p>
      {air.packets.length === 0 ? <div className="empty muted">Nothing heard yet.</div> : null}
      <ul className="air-list" role="list">
        {air.packets.slice(0, 200).map((p) => {
          const type = p.packet ? p.packet.payloadType : -1;
          const shown = open === p.id;
          return (
            <li key={p.id}>
              <button type="button" className={["air-row", shown ? "open" : ""].join(" ")} aria-expanded={shown} onClick={() => setOpen(shown ? null : p.id)}>
                <span className={`air-type ${typeKind(type)}`}>{p.packet ? typeName(type) : "?"}</span>
                <span className="air-about">{about(p, state)}</span>
                <span className="air-snr mono">{formatSnr(p.snr)} dB</span>
                <ChevronDownIcon size={14} className="air-chev" />
              </button>
              {shown && p.packet ? (
                <dl className="air-detail">
                  <dt>Heard</dt>
                  <dd>
                    {new Date(p.at).toLocaleTimeString()} · {formatSnr(p.snr)} dB · {formatDbm(p.rssi)}
                  </dd>
                  <dt>Route</dt>
                  <dd>{p.packet.flood ? "flood" : "direct"}</dd>
                  <dt>Through</dt>
                  <dd>{p.packet.path.length ? p.packet.path.map((h) => nameOfHash(h, state.contacts) ?? h).join(" › ") : "nobody: heard direct"}</dd>
                  <dt>Size</dt>
                  <dd>
                    {p.size} B{self ? ` · ${Math.round(airtimeMs(p.size, self))} ms on air` : ""}
                  </dd>
                </dl>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
