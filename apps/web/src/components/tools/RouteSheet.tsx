/**
 * The route to a contact, in a sheet over the map: the way the radio holds,
 * what the last check or search along it came to, and the one thing worth
 * doing next. A check traces five times out along the route and back; a
 * search floods a request, and the way it finds becomes the route. A point
 * dragged or a repeater tapped on the map starts a change, checked before it
 * is kept. How long a learned route lasts, and flooding instead, are in ⋯.
 * Everywhere else a route is one row that opens this.
 */

import { AdvType, contactRoute, isConversationType, type ContactRecord, type SessionState } from "@meshnet/meshcore";
import { useState, type ReactNode } from "react";
import { discover, forgetDiscovery, undoDiscovery, useDiscovery, type Discovery } from "../../lib/discovery.js";
import { nameOfHash } from "../../lib/echoes.js";
import { agoPhrase } from "../../lib/format.js";
import { legId, useLegVerdicts } from "../../lib/legVerdicts.js";
import { formatSnr, quality, QUALITY_WORDS, type LinkRadio } from "../../lib/los.js";
import { contactEnd, defaultHeight, relayOf, sameRelays, selfEnd } from "../../lib/mapOverlay.js";
import { setMeshTool, type RouteTool } from "../../lib/meshTool.js";
import { findBreak, measuredLegs, ping, ROUNDS, settlePing, stopPing, usePing, weakestLeg, type Ping } from "../../lib/ping.js";
import { inMinutes, limitLabel, ROUTE_LIMITS, routeStatus, useNow } from "../../lib/routes.js";
import { session, useSession } from "../../lib/session.js";
import { act, toast } from "../../lib/toast.js";
import { cancelRouteEdit, openLineOfSight, openRoute } from "../../lib/toolActions.js";
import { Button, IconButton } from "../../ui/Button.js";
import { LinkRow } from "../../ui/List.js";
import { showMenu, type MenuItem } from "../../ui/Menu.js";
import { AlertIcon, BackIcon, CheckIcon, ChevronRightIcon, MoreIcon } from "../Icons.js";
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

/** The row that stands for a route wherever a node is shown: how it goes, and how it did last; it opens the sheet. */
export function RouteLink({ contactKey }: { contactKey: string }) {
  const state = useSession();
  const p = usePing(contactKey);
  const d = useDiscovery(contactKey);
  const contact = state.contacts[contactKey];
  if (!contact) return null;
  const status = routeStatus(contact, p, d);
  return <LinkRow label="Route" value={<span className={`route-${status.tone}`}>{status.text}</span>} onClick={() => openRoute(contactKey)} />;
}

/** The relays a ping went through, and the contact when it passes nothing on. */
function relaysOf(p: Ping): string[] {
  return p.targetInChain ? p.chain.slice(0, -1) : p.chain;
}

/** Each node along the route, this radio first, by name where the hash names one contact. */
function namesAlong(p: Ping, contact: ContactRecord, state: SessionState): string[] {
  return ["You", ...relaysOf(p).map((h) => nameOfHash(h, state.contacts) ?? h), contact.name || contact.prefix];
}

/** The two ends of leg `index` of the route, when both are on the map. */
function legEnds(p: Ping, contact: ContactRecord, state: SessionState, index: number) {
  const ends = [selfEnd(state), ...relaysOf(p).map((h) => { const r = relayOf(h, state.contacts); return r ? contactEnd(r) : null; }), contactEnd(contact)];
  const a = ends[index];
  const b = ends[index + 1];
  return a && b ? { a, b } : null;
}

interface Action {
  label: string;
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  /** Said beside it: what it costs. */
  cost?: string;
}

export function RouteSheet({ tool, onClose }: { tool: RouteTool; onClose: () => void }) {
  const state = useSession();
  const now = useNow();
  const p = usePing(tool.key);
  const d = useDiscovery(tool.key);
  const [signingIn, setSigningIn] = useState(false);
  const [saving, setSaving] = useState(false);
  const contact = state.contacts[tool.key];
  const self = state.self;
  const radio: LinkRadio | null = self ? { frequencyKhz: self.frequencyKhz, bandwidthHz: self.bandwidthHz, spreadingFactor: self.spreadingFactor, codingRate: self.codingRate, txPowerDbm: self.txPower } : null;
  const nodeOf = (k: string) => state.contacts[k] ?? relayOf(k, state.contacts);
  // The legs of a change the terrain closes, warned of before it is kept.
  const draftEnds = tool.draft ? [selfEnd(state), ...tool.draft.map((k) => { const c = nodeOf(k); return c ? contactEnd(c) : null; }), contact ? contactEnd(contact) : null] : [];
  const draftLegs = draftEnds.slice(1).flatMap((b, i) => {
    const a = draftEnds[i];
    return a && b ? [{ a, b, ha: defaultHeight(a, state.contacts), hb: defaultHeight(b, state.contacts) }] : [];
  });
  const verdicts = useLegVerdicts(draftLegs, radio);

  if (!contact) {
    return (
      <div className="tool">
        <SheetHead title="Route" sub="This contact is no longer on the radio." onBack={onClose} />
      </div>
    );
  }

  const key = contact.key;
  const name = contact.name || contact.prefix;
  const online = state.status === "ready";
  const relaysItself = contact.type === AdvType.Repeater;
  const governed = isConversationType(contact.type);
  const policy = session.routePolicy(key);
  const flooding = governed && policy.flood;
  const held = contactRoute(contact);
  const byHand = session.routeSetByHand(key);
  const expires = session.routeExpiresAt(key);
  // A repeater or a room answers a search only from a radio signed in to it.
  const needsSignIn = (contact.type === AdvType.Repeater || contact.type === AdvType.Room) && !state.logins[key]?.ok;
  const placed = !!contactEnd(contact);
  const editing = tool.draft !== null;

  // A change, as the radio would hold it: hashes the size of the route it holds now.
  const size = held?.[0] ? held[0].length / 2 : (state.device?.pathHashMode ?? 0) + 1;
  const hashes = (tool.draft ?? []).map((k) => k.slice(0, size * 2));
  const draftPing = tool.draft && p?.via && sameRelays(p.via, tool.draft) ? p : null;
  const heldPing = p && !p.via ? p : null;
  const shownPing = editing ? draftPing : heldPing;
  const running = shownPing?.running ?? false;
  const searching = d?.running ?? false;
  // The newer of a check and a search says what it found.
  const shownSearch = !editing && d && (d.running || !heldPing || d.at >= heldPing.at) ? d : null;

  const openLeg = (index: number) => {
    if (!shownPing) return;
    const ends = legEnds(shownPing, contact, state, index);
    if (ends) openLineOfSight(ends.a, ends.b, key, measuredLegs(shownPing)[index] ?? null);
  };

  const find = () => (needsSignIn ? setSigningIn(true) : void discover(key));
  const save = async () => {
    setSaving(true);
    const ok = await act(() => session.setRoute(key, hashes), "Route saved");
    setSaving(false);
    if (!ok) return;
    settlePing(key, hashes);
    // What a search found was measured against the route this one replaces.
    forgetDiscovery(key);
    setMeshTool({ ...tool, draft: null });
  };

  // ---- what it says about the route ----

  let sub: string;
  if (editing) sub = "Not saved yet";
  else if (flooding) sub = "Every message floods";
  else if (held === null) sub = relaysItself ? "None written: a check follows its adverts" : governed ? "None known: messages flood" : "None known: requests to it flood";
  else {
    const bits = [byHand ? "set by hand" : contact.pathSince ? `learned ${agoPhrase(contact.pathSince)}` : null, expires !== null ? `forgotten ${inMinutes(expires - now)}` : null].filter(Boolean).join(" · ");
    sub = bits ? bits[0]!.toUpperCase() + bits.slice(1) : held.length === 0 ? "Heard direct" : "Kept until the radio learns another";
  }

  const relayName = (k: string) => nodeOf(k)?.name || (state.contacts[k] ? k.slice(0, 8) : (nameOfHash(k, state.contacts) ?? k));
  const chain: string[] | null = editing ? tool.draft!.map(relayName) : flooding ? null : held ? held.map((h) => nameOfHash(h, state.contacts) ?? h) : relaysItself && heldPing?.chain.length ? relaysOf(heldPing).map((h) => nameOfHash(h, state.contacts) ?? h) : null;

  // ---- the one thing to do, and what else fits ----

  const checkHeld = relaysItself || (held !== null && held.length > 0);
  const lastFailed = !shownSearch && !!heldPing && !heldPing.running && heldPing.mode === "rounds" && heldPing.runs.length > 0 && heldPing.runs.every((r) => !r.ok);
  const findLabel = held === null && !relaysItself ? "Find a way" : "Find a new way";
  let primary: Action | null = null;
  const links: Action[] = [];
  if (editing) {
    // Two buttons of their own, below.
  } else if (running) {
    primary = { label: "Stop", onClick: () => stopPing(key) };
  } else if (searching) {
    primary = { label: "Looking for a way…", onClick: () => undefined, busy: true };
  } else if (flooding) {
    primary = null;
  } else if (lastFailed) {
    primary = { label: needsSignIn ? "Sign in to find a way" : findLabel, onClick: find, disabled: !online };
    if (heldPing!.chain.length > 1) links.push({ label: "Where it breaks", onClick: () => void findBreak(key), disabled: !online });
    links.push({ label: "Check again", onClick: () => void ping(key), disabled: !online });
  } else if (checkHeld) {
    primary = { label: "Check", onClick: () => void ping(key), disabled: !online };
    links.push({ label: findLabel, onClick: find, disabled: !online, cost: needsSignIn ? "sign in first" : "floods" });
  } else if (held === null) {
    primary = { label: needsSignIn ? "Sign in to find a way" : findLabel, onClick: find, disabled: !online };
  } else {
    links.push({ label: findLabel, onClick: find, disabled: !online, cost: needsSignIn ? "sign in first" : "floods" });
  }

  const hint = editing
    ? "Drag a point, or tap repeaters in order. Saving writes it to the radio and sends nothing."
    : flooding
      ? "Always flood is on: turn it off in ⋯ to use routes again."
      : placed
        ? "Drag a point on the map, or tap repeaters, to change it."
        : `${name} shares no position: tap repeaters on the map, in order, to set a route.`;

  const settings = () => {
    const items: MenuItem[] = [];
    if (governed) {
      items.push({
        label: flooding ? "Use learned routes again" : "Always flood",
        hint: flooding ? undefined : "Ignore learned routes. Handy on the move; costs a flood per message.",
        disabled: !online,
        onSelect: () => void act(() => session.setFloodPinned(key, !flooding), flooding ? "Learned routes again" : "Every message to it floods"),
      });
      if (!flooding) {
        const own = state.routing.contacts[key]?.resetAfterMin;
        items.push({ label: `Forget learned routes after: ${own === undefined ? "default" : limitLabel(own).toLowerCase()}`, onSelect: () => forgetAfter(key, own, state.routing.resetAfterMin) });
      }
    }
    items.push({ label: "Forget the route now", danger: true, disabled: !online || held === null || flooding, onSelect: () => void act(() => session.resetPath(key), "Route forgotten: the next message floods") });
    showMenu(items, { title: `Route to ${name}` });
  };

  return (
    <div className="tool route-sheet">
      <SheetHead title={`Route to ${name}`} sub={sub} onBack={onClose} onMore={settings} />
      {chain ? (
        <p className="tool-line chain">
          <span className="muted">You</span>
          {chain.map((n, i) => (
            <span key={`${i}:${n}`}>
              <span className="sep">›</span>
              <b>{n}</b>
            </span>
          ))}
          <span className="sep">›</span>
          <span className="muted">{name}</span>
        </p>
      ) : null}
      {editing
        ? draftLegs
            .filter((l) => verdicts.get(legId(l.a, l.b)) === "blocked")
            .map((l) => (
              <p key={legId(l.a, l.b)} className="tool-warn">
                <AlertIcon size={16} />
                {l.a.name} → {l.b.name} is blocked by terrain.
              </p>
            ))
        : null}
      {shownSearch ? <SearchResult d={shownSearch} contact={contact} state={state} /> : shownPing ? <CheckResult p={shownPing} contact={contact} state={state} onLeg={openLeg} /> : null}

      {editing ? (
        <div className="tool-actions">
          <Button size="lg" disabled={!online || (!running && !(relaysItself || hashes.length > 0))} onClick={() => (running ? stopPing(key) : void ping(key, hashes))}>
            {running ? "Stop" : "Check"}
          </Button>
          <Button variant="primary" size="lg" busy={saving} disabled={!online || running} onClick={() => void save()}>
            Save route
          </Button>
        </div>
      ) : primary ? (
        <Button variant={running ? "default" : "primary"} size="lg" busy={primary.busy ?? false} disabled={primary.disabled ?? false} onClick={primary.onClick}>
          {primary.label}
        </Button>
      ) : null}
      {editing ? (
        <div className="route-links">
          <button type="button" className="check-link" onClick={cancelRouteEdit}>
            Cancel
          </button>
        </div>
      ) : links.length ? (
        <div className="route-links">
          {links.map((l) => (
            <button key={l.label} type="button" className="check-link" disabled={l.disabled} onClick={l.onClick}>
              {l.label}
              {l.cost ? <small>{l.cost}</small> : null}
            </button>
          ))}
        </div>
      ) : null}
      <p className="tool-credit muted">{hint}</p>

      <SignIn
        open={signingIn}
        nodeKey={key}
        onClose={() => setSigningIn(false)}
        onSignedIn={() => {
          setSigningIn(false);
          toast(`Signed in to ${name}`);
          void discover(key);
        }}
      />
    </div>
  );
}

function SheetHead({ title, sub, onBack, onMore }: { title: string; sub: ReactNode; onBack: () => void; onMore?: () => void }) {
  return (
    <div className="tool-head">
      <IconButton label="Back" onClick={onBack}>
        <BackIcon size={18} />
      </IconButton>
      <span className="row-main">
        <span className="row-title">{title}</span>
        <span className="row-sub muted">{sub}</span>
      </span>
      {onMore ? (
        <IconButton label="Route settings" onClick={onMore}>
          <MoreIcon size={18} />
        </IconButton>
      ) : null}
    </div>
  );
}

/** How long a learned route to this contact is kept: the default, or its own. */
function forgetAfter(key: string, own: number | null | undefined, fallback: number | null): void {
  const mark = (on: boolean) => <CheckIcon size={17} style={{ visibility: on ? "visible" : "hidden" }} />;
  showMenu(
    [
      { label: `Default (${limitLabel(fallback).toLowerCase()})`, icon: mark(own === undefined), onSelect: () => session.setRouteReset(key, undefined) },
      ...ROUTE_LIMITS.map((m) => ({ label: limitLabel(m), icon: mark(own === m), onSelect: () => session.setRouteReset(key, m) })),
    ],
    { title: "Forget learned routes after" },
  );
}

/**
 * What a search came to: the flood on its way, the way it found (drawn on
 * the map with the way back and the route it replaced), or the silence.
 */
function SearchResult({ d, contact, state }: { d: Discovery; contact: ContactRecord; state: SessionState }) {
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
    const flooding = isConversationType(contact.type) && session.routePolicy(contact.key).flood;
    const head = f.out.length === 0 ? "Heard direct, no relays" : f.changed ? `Found a way via ${f.out.length} relay${f.out.length === 1 ? "" : "s"}` : "Same way as the route";
    return (
      <div className="disc">
        <p className="disc-line">
          <b>{head}</b> · {flooding ? "it still floods" : f.changed ? "now the route" : "it still works"}
          {f.changed && !flooding ? (
            <>
              {" · "}
              <button type="button" className="check-link" disabled={state.status !== "ready"} onClick={() => void act(() => undoDiscovery(d.key), "Route put back")}>
                Undo
              </button>
            </>
          ) : null}
        </p>
        {contactEnd(contact) ? (
          <span className="disc-key">
            <span><i className="found" />there</span>
            <span><i className="back" />back</span>
            {f.changed && d.before ? <span><i className="was" />was</span> : null}
          </span>
        ) : null}
      </div>
    );
  }
  if (!d.silent) return <p className="check-note">{d.error}</p>;
  const needsSignIn = (contact.type === AdvType.Repeater || contact.type === AdvType.Room) && !state.logins[contact.key]?.ok;
  return (
    <p className="disc-line bad">
      <b>No answer in {d.waitedS} s.</b> {needsSignIn ? `${contact.name || contact.prefix} answers only a radio signed in to it.` : "It may be out of range right now."}
    </p>
  );
}

/** What a check or a search for the break came to, in a line or two; a leg named in it opens its line of sight. */
function CheckResult({ p, contact, state, onLeg }: { p: Ping; contact: ContactRecord; state: SessionState; onLeg: (index: number) => void }) {
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
          Check {Math.min(done + 1, ROUNDS)} of {ROUNDS}…
        </span>
      </div>
    );
  }
  if (done === 0) return null;
  // A person, a room or a sensor passes nothing on: a check goes as far as its last repeater.
  const reach = p.targetInChain ? null : names[names.length - 2];
  if (good.length === 0) {
    return (
      <div className="check-result">
        <b className="bad">No answer</b>
        <span className="muted">
          0 of {done} came back{reach ? ` from ${reach}` : ""}
        </span>
      </div>
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
          {good.length} of {done} came back{reach ? ` · as far as ${reach}` : ""}
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
