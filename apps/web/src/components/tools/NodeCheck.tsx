/**
 * Ping, on a node's card and profile: one button that traces five times out
 * along the route and back, and what came of it in a line. A repeater is
 * pinged itself; a person, a room or a sensor passes nothing on, so what is
 * checked is the way to its last repeater. Where the route breaks is asked
 * only once nothing came back. Beside it, Discover floods a request and the
 * way it finds becomes the route; the map draws it, and the way back.
 */

import { AdvType, contactRoute, type ContactRecord, type SessionState } from "@meshnet/meshcore";
import { useState } from "react";
import { discover, undoDiscovery, useDiscovery, type Discovery } from "../../lib/discovery.js";
import { nameOfHash } from "../../lib/echoes.js";
import { formatSnr, quality, QUALITY_WORDS, traceAirtimeMs } from "../../lib/los.js";
import { contactEnd, relayOf, selfEnd } from "../../lib/mapOverlay.js";
import { findBreak, measuredLegs, ping, ROUNDS, stopPing, usePing, weakestLeg, type Ping } from "../../lib/ping.js";
import { session, useSession } from "../../lib/session.js";
import { act, toast } from "../../lib/toast.js";
import { changeRoute, openLineOfSight } from "../../lib/toolActions.js";
import { Button } from "../../ui/Button.js";
import { AirMark } from "../../ui/List.js";
import { AirIcon, AlertIcon, ChevronRightIcon, SignalIcon, WavesIcon } from "../Icons.js";
import { SignIn } from "../node/SignIn.js";

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
export function legEnds(p: Ping, contact: ContactRecord, state: SessionState, index: number) {
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
  const d = useDiscovery(contactKey);
  const contact = state.contacts[contactKey];
  if (!contact) return null;
  const relaysItself = contact.type === AdvType.Repeater;
  const online = state.status === "ready";
  const route = contactRoute(contact);
  const byHand = session.routeSetByHand(contactKey);
  const running = p?.running ?? false;
  const asking = d?.running ?? false;
  // The newer of the two says what it found.
  const shownDiscovery = d && (d.running || !p || d.at >= p.at) ? d : null;

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
      {shownDiscovery ? <DiscoveryResult d={shownDiscovery} contact={contact} state={state} /> : p && !p.via ? <PingResult p={p} contact={contact} state={state} onLeg={openLeg} /> : null}
      <div className="check-buttons">
        <Button size="lg" busy={asking} disabled={!online || running} onClick={() => void discover(contactKey)}>
          <AirIcon size={18} />
          Discover
        </Button>
        <Button variant={running ? "default" : "primary"} size="lg" disabled={!online || asking || (!canCheck && !running)} onClick={() => (running ? stopPing(contactKey) : void ping(contactKey))}>
          <SignalIcon size={18} />
          {running ? "Stop" : relaysItself ? (p?.runs.length ? "Ping again" : "Ping") : "Check"}
        </Button>
      </div>
      <div className="check-cost">
        <WavesIcon size={13} />
        {canCheck ? `${ROUNDS} round trips${air ? ` · ${air.toFixed(1)} s on air` : ""}` : "Nothing between you to check"}
      </div>
    </div>
  );
}

/**
 * What a discovery came to: the flood on its way, the way it found (drawn on
 * the map with the way back and the route it replaced), or the silence, and
 * the one thing to do about it.
 */
function DiscoveryResult({ d, contact, state }: { d: Discovery; contact: ContactRecord; state: SessionState }) {
  const [signingIn, setSigningIn] = useState(false);
  const name = contact.name || contact.prefix;
  if (d.running) {
    const job = state.remote.active?.key === d.key && state.remote.active.label === "path discovery" ? state.remote.active : null;
    const total = job?.until && job.startedAt ? Math.round((job.until - job.startedAt) / 1000) : null;
    return (
      <div className="disc">
        <p className="disc-line">{total ? `Flooding… an answer takes up to ${total} s` : "Waiting for the radio…"}</p>
        {job?.until ? (
          <span className="disc-bar" aria-hidden="true">
            <i key={job.id} style={{ animationDuration: `${job.until - (job.startedAt ?? job.until)}ms` }} />
          </span>
        ) : null}
      </div>
    );
  }
  if (d.found) {
    const f = d.found;
    const onMap = !!contactEnd(contact);
    const head = f.out.length === 0 ? "Heard direct, no relays" : f.changed ? `Found a way via ${f.out.length} relay${f.out.length === 1 ? "" : "s"}` : "Same way as the route";
    return (
      <div className="disc">
        <p className="disc-line">
          <b>{head}</b> · {f.changed ? "now the route" : "it still works"}
          {f.changed ? (
            <>
              {" · "}
              <button type="button" className="check-link" disabled={state.status !== "ready"} onClick={() => void act(() => undoDiscovery(d.key), "Route put back")}>
                Undo
              </button>
            </>
          ) : null}
        </p>
        {onMap ? (
          <span className="disc-key">
            <span><i className="found" />there</span>
            <span><i className="back" />back</span>
            {f.changed && d.before ? <span><i className="was" />was</span> : null}
          </span>
        ) : null}
      </div>
    );
  }
  // A repeater or a room answers only a radio signed in to it.
  const needsSignIn = (contact.type === AdvType.Repeater || contact.type === AdvType.Room) && !state.logins[contact.key]?.ok;
  if (!d.silent) return <p className="check-note">{d.error}</p>;
  return (
    <div className="disc">
      <p className="disc-line bad">
        <b>No answer in {d.waitedS} s.</b> {needsSignIn ? `${name} answers only a radio signed in to it.` : "It may be out of range right now."}
        {needsSignIn ? (
          <>
            {" "}
            <button type="button" className="check-link" onClick={() => setSigningIn(true)}>
              Sign in
            </button>
          </>
        ) : null}
      </p>
      <SignIn
        open={signingIn}
        nodeKey={contact.key}
        onClose={() => setSigningIn(false)}
        onSignedIn={() => {
          setSigningIn(false);
          toast(`Signed in to ${name}`);
        }}
      />
    </div>
  );
}

/** What a ping or a search for the break came to, in a line or two; a leg named in it opens its line of sight. */
export function PingResult({ p, contact, state, onLeg }: { p: Ping; contact: ContactRecord; state: SessionState; onLeg: (index: number) => void }) {
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
          <button type="button" className="check-row" onClick={() => void findBreak(p.key, p.via)}>
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

