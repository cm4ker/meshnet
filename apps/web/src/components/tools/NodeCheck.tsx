/**
 * Ping, on a node's card and profile: one button that traces five times out
 * along the route and back, and what came of it in a line. A repeater is
 * pinged itself; a person, a room or a sensor passes nothing on, so what is
 * checked is the way to its last repeater. Where the route breaks is asked
 * only once nothing came back.
 */

import { AdvType, contactRoute, type ContactRecord, type SessionState } from "@meshnet/meshcore";
import { nameOfHash } from "../../lib/echoes.js";
import { formatSnr, quality, QUALITY_WORDS, traceAirtimeMs } from "../../lib/los.js";
import { contactEnd, relayOf, selfEnd } from "../../lib/mapOverlay.js";
import { findBreak, measuredLegs, ping, ROUNDS, stopPing, usePing, weakestLeg, type Ping } from "../../lib/ping.js";
import { session, useSession } from "../../lib/session.js";
import { changeRoute, openLineOfSight } from "../../lib/toolActions.js";
import { Button } from "../../ui/Button.js";
import { AirMark } from "../../ui/List.js";
import { AlertIcon, ChevronRightIcon, SignalIcon, WavesIcon } from "../Icons.js";

export function QualityChip({ snr, numbers = true }: { snr: number; numbers?: boolean }) {
  const q = quality(snr);
  return (
    <span className={`quality ${q}`}>
      {QUALITY_WORDS[q]}
      {numbers ? <small>{formatSnr(snr)} dB</small> : null}
    </span>
  );
}

/** Each node along the route, this radio first, by name where the hash names one contact. */
function namesAlong(p: Ping, contact: ContactRecord, state: SessionState): string[] {
  const relays = p.targetInChain ? p.chain.slice(0, -1) : p.chain;
  return ["You", ...relays.map((h) => nameOfHash(h, state.contacts) ?? h), contact.name || contact.prefix];
}

/** The two ends of leg `index` of the route, when both are on the map. */
function legEnds(p: Ping, contact: ContactRecord, state: SessionState, index: number) {
  const relays = p.targetInChain ? p.chain.slice(0, -1) : p.chain;
  const ends = [selfEnd(state), ...relays.map((h) => { const r = relayOf(h, state.contacts); return r ? contactEnd(r) : null; }), contactEnd(contact)];
  const a = ends[index];
  const b = ends[index + 1];
  return a && b ? { a, b } : null;
}

/** `route` shows the route it checks, with Change; a profile shows its route in a row of its own. */
export function NodeCheck({ contactKey, route: showRoute = true }: { contactKey: string; route?: boolean }) {
  const state = useSession();
  const p = usePing(contactKey);
  const contact = state.contacts[contactKey];
  if (!contact) return null;
  const relaysItself = contact.type === AdvType.Repeater;
  const online = state.status === "ready";
  const route = contactRoute(contact);
  const byHand = session.routeSetByHand(contactKey);
  const running = p?.running ?? false;

  const via =
    route === null
      ? relaysItself
        ? "the way its adverts came"
        : "none: messages flood"
      : route.length === 0
        ? "direct"
        : route.map((h) => nameOfHash(h, state.contacts) ?? h).join(" › ");
  const canCheck = relaysItself || (route !== null && route.length > 0);

  // What five rounds cost on the air, when the route is known.
  const self = state.self;
  const hops = route === null ? null : route.length + (relaysItself ? 1 : 0);
  const air = self && hops ? (traceAirtimeMs(hops, route && route[0] ? route[0].length / 2 : 1, self) * ROUNDS) / 1000 : null;

  const openLeg = (index: number) => {
    if (!p) return;
    const ends = legEnds(p, contact, state, index);
    if (!ends) return;
    const leg = measuredLegs(p)[index] ?? null;
    openLineOfSight(ends.a, ends.b, contactKey, leg);
  };

  return (
    <div className="check">
      {showRoute ? (
      <div className="check-route">
        <span className="check-route-text">
          {relaysItself ? "Path" : "Route"}: <b>{via}</b>
          {byHand ? <span className="muted"> · set by hand</span> : null}
        </span>
        <button type="button" className="check-link" disabled={!online || running} onClick={() => changeRoute(contactKey)}>
          Change
        </button>
      </div>
      ) : null}
      {p ? <Result p={p} contact={contact} state={state} onLeg={openLeg} /> : null}
      <Button variant={running ? "default" : "primary"} size="lg" disabled={!online || (!canCheck && !running)} onClick={() => (running ? stopPing(contactKey) : void ping(contactKey))}>
        <SignalIcon size={18} />
        {running ? "Stop" : relaysItself ? (p?.runs.length ? "Ping again" : "Ping") : "Check the route"}
      </Button>
      <div className="check-cost">
        <WavesIcon size={13} />
        {canCheck ? `${ROUNDS} round trips${air ? ` · ${air.toFixed(1)} s on air` : ""}` : "Nothing between you to check"}
      </div>
    </div>
  );
}

function Result({ p, contact, state, onLeg }: { p: Ping; contact: ContactRecord; state: SessionState; onLeg: (index: number) => void }) {
  const names = namesAlong(p, contact, state);
  if (p.error && !p.running) return <p className="check-note">{p.error}</p>;

  if (p.mode === "hops" && p.hops) {
    if (p.running) {
      const at = p.hops.findIndex((h) => h.state === "trying");
      return <p className="check-note">Checking hop {Math.max(at, 0) + 1} of {p.hops.length}…</p>;
    }
    const silent = p.hops.findIndex((h) => h.state === "silent");
    if (silent < 0) return <p className="check-note">Every hop answers now: the loss before was a weak moment, not a gap.</p>;
    return (
      <button type="button" className="check-row bad" onClick={() => onLeg(silent)}>
        <AlertIcon size={18} />
        <span className="grow">
          Breaks after {names[silent]}
          <small>
            {names[silent + 1]} stayed silent twice · tap for the line of sight
          </small>
        </span>
        <ChevronRightIcon size={14} className="line-chev" />
      </button>
    );
  }

  const done = p.runs.length;
  const good = p.runs.filter((r) => r.ok);
  if (p.running) {
    return (
      <div className="check-result">
        <span className="dots" aria-hidden="true">
          {Array.from({ length: ROUNDS }, (_, i) => (
            <i key={i} className={i < done ? (p.runs[i]!.ok ? "ok" : "lost") : i === done ? "wait" : ""} />
          ))}
        </span>
        <span className="muted">
          Ping {Math.min(done + 1, ROUNDS)} of {ROUNDS}…
        </span>
      </div>
    );
  }
  if (done === 0) return null;
  if (good.length === 0) {
    return (
      <>
        <div className="check-result">
          <b className="bad">No answer</b>
          <span className="muted">0 of {done} came back</span>
        </div>
        {p.chain.length > 1 ? (
          <button type="button" className="check-row" onClick={() => void findBreak(p.key)}>
            <span className="grow">
              Find where it breaks
              <small>One hop further each time, until one stays silent</small>
            </span>
            <AirMark />
          </button>
        ) : null}
      </>
    );
  }
  const avg = good.reduce((s, r) => s + (r.rttMs ?? 0), 0) / good.length;
  const weakest = weakestLeg(p);
  const lost = done - good.length;
  const ends = weakest ? legEnds(p, contact, state, weakest.index) : null;
  return (
    <>
      <div className="check-result">
        <b className="mono">{Math.round(avg)} ms</b>
        <span className="muted">
          {good.length} of {done} came back
        </span>
        {weakest ? <QualityChip snr={weakest.snr} numbers={false} /> : null}
      </div>
      {weakest && (weakest.snr < -5 || lost > 0) ? (
        <button type="button" className="check-row warn" disabled={!ends} onClick={() => onLeg(weakest.index)}>
          <AlertIcon size={18} />
          <span className="grow">
            Weakest: {names[weakest.index]} ↔ {names[weakest.index + 1]}
            <small>
              {formatSnr(weakest.snr)} dB{ends ? " · tap for the line of sight" : " · one end has no position"}
            </small>
          </span>
          {ends ? <ChevronRightIcon size={14} className="line-chev" /> : null}
        </button>
      ) : null}
    </>
  );
}

