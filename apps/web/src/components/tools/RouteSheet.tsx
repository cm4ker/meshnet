/**
 * The route to a contact, in a sheet over the map: the way the radio holds,
 * what the last check of it came to, and one button. Check traces five times
 * out along the route and back; when that stays silent it finds where the
 * route breaks and looks for a way round in what the radio has heard, and a
 * way that comes back becomes the route (lib/ping.ts). A point dragged or a
 * repeater tapped on the map starts a change, and the same button checks it
 * and then saves it. Asking the whole mesh (a flood), the way from here to
 * another repeater, and how long a learned route lasts are in ⋯.
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
import { setMeshTool, type LosEnd, type RouteTool } from "../../lib/meshTool.js";
import { keepLooking, measuredLegs, ping, ROUNDS, settlePing, stopPing, undoFound, usePing, weakestLeg, type Ping } from "../../lib/ping.js";
import { inMinutes, limitLabel, ROUTE_LIMITS, routeStatus, useNow } from "../../lib/routes.js";
import { session, useSession } from "../../lib/session.js";
import { act, toast } from "../../lib/toast.js";
import { cancelRouteEdit, openLineOfSight, openRoute, openSpan } from "../../lib/toolActions.js";
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

/** Where along a chain it broke: after the node before the leg, or at the first hop. */
export function breakWords(p: Ping, state: SessionState): string | null {
  if (!p.broken) return null;
  const { chain, at } = p.broken;
  return at === 0 ? "at the first hop" : `after ${nameOfHash(chain[at - 1]!, state.contacts) ?? chain[at - 1]}`;
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
  // A repeater or a room answers a flood only from a radio signed in to it.
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
  const flooded = d?.running ?? false;
  // The newer of a check and a flood says what it found.
  const shownFlood = !editing && d && (d.running || !heldPing || d.at >= heldPing.at) ? d : null;

  const openLeg = (index: number) => {
    if (!shownPing) return;
    const ends = legEnds(shownPing, contact, state, index);
    if (ends) openLineOfSight(ends.a, ends.b, key, measuredLegs(shownPing)[index] ?? null);
  };

  const flood = () => (needsSignIn ? setSigningIn(true) : void discover(key));
  const save = async () => {
    setSaving(true);
    const ok = await act(() => session.setRoute(key, hashes), "Route saved");
    setSaving(false);
    if (!ok) return;
    settlePing(key, hashes);
    // What a flood found was measured against the route this one replaces.
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
  const shownChain = heldPing && !heldPing.running && heldPing.search?.found ? relaysOf(heldPing) : null;
  const chain: string[] | null = editing
    ? tool.draft!.map(relayName)
    : flooding
      ? null
      : shownChain
        ? shownChain.map((h) => nameOfHash(h, state.contacts) ?? h)
        : held
          ? held.map((h) => nameOfHash(h, state.contacts) ?? h)
          : relaysItself && heldPing?.chain.length && !heldPing.search
            ? relaysOf(heldPing).map((h) => nameOfHash(h, state.contacts) ?? h)
            : null;

  // ---- the one button, and a link when one is worth it ----

  let primary: (Action & { plain?: boolean }) | null = null;
  const links: Action[] = [];
  if (editing) {
    const cameBack = !!draftPing && !draftPing.running && draftPing.runs.some((r) => r.ok);
    primary = running
      ? { label: "Stop", onClick: () => stopPing(key), plain: true }
      : cameBack
        ? { label: "Save route", onClick: () => void save(), busy: saving, disabled: !online }
        : { label: "Check", onClick: () => void ping(key, hashes), disabled: !online || !(relaysItself || hashes.length > 0) };
    if (!running) links.push({ label: "Cancel", onClick: cancelRouteEdit });
  } else if (running) {
    primary = { label: "Stop", onClick: () => stopPing(key), plain: true };
  } else if (flooded) {
    primary = { label: "Asking the whole mesh…", onClick: () => undefined, busy: true };
  } else if (!flooding) {
    // A search that found nothing goes on from where it stopped; the flood is the last resort.
    const gaveUp = !shownFlood && !!heldPing?.search?.done && !heldPing.search.found;
    primary = gaveUp
      ? { label: "Keep looking", onClick: () => void keepLooking(key), disabled: !online }
      : { label: held === null && !relaysItself ? "Find a way" : "Check", onClick: () => void ping(key), disabled: !online };
    if (gaveUp) links.push({ label: "Ask the whole mesh", onClick: flood, disabled: !online, cost: needsSignIn ? "sign in first" : "floods" });
  }

  const idle = !running && !shownFlood && !shownPing;
  const hint = editing
    ? "Drag a point, or tap repeaters in order. Saving writes it to the radio and sends nothing."
    : flooding
      ? "Always flood is on: turn it off in ⋯ to use routes again."
      : !idle
        ? null
        : placed
          ? "Drag a point on the map to change the route."
          : `${name} shares no position: tap repeaters on the map, in order, to set a route.`;

  const settings = () => {
    const items: MenuItem[] = [
      {
        label: "Ask the whole mesh",
        hint: needsSignIn ? "Floods a request. It answers only a radio signed in to it." : "Floods a request; the way it finds becomes the route.",
        disabled: !online || flooded || running,
        onSelect: flood,
      },
    ];
    if (relaysItself) items.push({ label: "Check from here to…", hint: "How this repeater and another you tap hear each other.", disabled: !online, onSelect: () => openSpan(key) });
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
      {shownFlood ? (
        <SearchResult d={shownFlood} contact={contact} state={state} />
      ) : shownPing ? (
        <CheckResult p={shownPing} names={namesAlong(shownPing, contact, state)} reach={shownPing.targetInChain ? null : relaysOf(shownPing).length ? namesAlong(shownPing, contact, state).at(-2)! : null} placed={placed} onLeg={openLeg} onUndo={() => void act(() => undoFound(key), "Route put back")} />
      ) : null}

      {primary ? (
        <Button variant={primary.plain ? "default" : "primary"} size="lg" busy={primary.busy ?? false} disabled={primary.disabled ?? false} onClick={primary.onClick}>
          {primary.label}
        </Button>
      ) : null}
      {links.length ? (
        <div className="route-links">
          {links.map((l) => (
            <button key={l.label} type="button" className="check-link" disabled={l.disabled} onClick={l.onClick}>
              {l.label}
              {l.cost ? <small>{l.cost}</small> : null}
            </button>
          ))}
        </div>
      ) : null}
      {hint ? <p className="tool-credit muted">{hint}</p> : null}

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

export function SheetHead({ title, sub, onBack, onMore }: { title: string; sub: ReactNode; onBack: () => void; onMore?: () => void }) {
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
 * What asking the whole mesh came to: the flood on its way, the way it found
 * (drawn on the map with the way back and the route it replaced), or the
 * silence.
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

function Dots({ marks, total, live }: { marks: boolean[]; total: number; live: boolean }) {
  return (
    <span className="dots" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => (
        <i key={i} className={i < marks.length ? (marks[i] ? "ok" : "lost") : i === marks.length && live ? "wait" : ""} />
      ))}
    </span>
  );
}

/**
 * What a check came to, in a line or two: how it is getting on while it
 * runs; the time, how many came back and the weakest leg in a word; where it
 * broke and the way round it found, with Undo; or that none was found. A leg
 * named in it opens its line of sight. `names` are the nodes along the way,
 * this radio first; `reach` the last a check can get to, when it stops short
 * of the contact.
 */
export function CheckResult({ p, names, reach, placed, onLeg, onUndo }: { p: Ping; names: string[]; reach: string | null; placed: boolean; onLeg: (index: number) => void; onUndo?: () => void }) {
  const state = useSession();
  if (p.error && !p.running) return <p className="check-note">{p.error}</p>;
  const broke = breakWords(p, state);

  if (p.running) {
    if (p.stage === "locate") {
      return (
        <div className="check-result">
          <Dots marks={p.runs.map((r) => r.ok)} total={ROUNDS} live={false} />
          <span className="muted">No answer twice · finding where it breaks…</span>
        </div>
      );
    }
    if (p.stage === "search" && p.search) {
      return (
        <>
          {broke ? (
            <p className="disc-line bad">
              <b>Breaks {broke}</b>
            </p>
          ) : null}
          <div className="check-result">
            <Dots marks={p.search.tries} total={p.search.total} live />
            <span className="muted">
              {p.broken ? "Trying another way" : "Looking for a way"} {Math.min(p.search.tries.length + 1, p.search.total)} of {p.search.total}…
            </span>
          </div>
        </>
      );
    }
    const done = p.runs.length;
    return (
      <div className="check-result">
        <Dots marks={p.runs.map((r) => r.ok)} total={ROUNDS} live />
        <span className="muted">
          Check {Math.min(done + 1, ROUNDS)} of {ROUNDS}…
        </span>
      </div>
    );
  }

  const weakest = weakestLeg(p);
  const weakRow = (lost: number) =>
    weakest && (weakest.snr < -5 || lost > 0) ? (
      <button type="button" className="check-row warn" onClick={() => onLeg(weakest.index)}>
        <AlertIcon size={18} />
        <span className="grow">
          Weakest: {names[weakest.index]} ↔ {names[weakest.index + 1]}
          <small>{formatSnr(weakest.snr)} dB · tap for the line of sight</small>
        </span>
        <ChevronRightIcon size={14} className="line-chev" />
      </button>
    ) : null;

  if (p.search) {
    if (p.search.found) {
      const relays = names.length - 2;
      const rtt = p.runs[0]?.rttMs;
      return (
        <>
          <div className="check-result">
            <b className="found-head">{p.broken ? "Found another way" : "Found a way"}</b>
            <span className="muted">
              via {relays} relay{relays === 1 ? "" : "s"}
              {rtt ? ` · back in ${(rtt / 1000).toFixed(1)} s` : ""}
            </span>
            {weakest ? <QualityChip snr={weakest.snr} numbers={false} /> : null}
          </div>
          <p className="check-note">
            {p.search.tries.length > 1 ? `On try ${p.search.tries.length} · ${p.broken ? `the old one broke ${broke}` : "now the route"}` : p.broken ? `The old one broke ${broke}` : "Now the route"}
            {p.search.before && onUndo ? (
              <>
                {" · "}
                <button type="button" className="check-link" onClick={onUndo}>
                  Undo
                </button>
              </>
            ) : null}
          </p>
          {p.search.back && placed ? (
            <span className="disc-key">
              <span><i className="found" />there</span>
              <span><i className="back" />back</span>
            </span>
          ) : null}
          {weakRow(0)}
        </>
      );
    }
    const silent = p.search.tries.length;
    return (
      <p className="disc-line bad">
        <b>No way found.</b> {broke ? `It breaks ${broke}. ` : ""}
        {silent ? `${silent} other way${silent === 1 ? "" : "s"} stayed silent.` : broke ? "Nothing the radio has heard goes round it." : "The radio has not heard enough of the mesh around it yet."}
      </p>
    );
  }

  if (p.broken) {
    return (
      <button type="button" className="check-row bad" onClick={() => onLeg(p.broken!.at)}>
        <AlertIcon size={18} />
        <span className="grow">
          No answer · breaks {broke}
          <small>tap for the line of sight</small>
        </span>
        <ChevronRightIcon size={14} className="line-chev" />
      </button>
    );
  }

  const done = p.runs.length;
  const good = p.runs.filter((r) => r.ok);
  if (done === 0) return null;
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
  return (
    <>
      <div className="check-result">
        <b className="mono">{Math.round(avg)} ms</b>
        <span className="muted">
          {good.length} of {done} came back{reach ? ` · as far as ${reach}` : ""}
        </span>
        {weakest ? <QualityChip snr={weakest.snr} numbers={false} /> : null}
      </div>
      {weakRow(done - good.length)}
    </>
  );
}

/** The ends of the legs along a traced chain, this radio first. */
export function chainEnds(chain: string[], state: SessionState, last: LosEnd | null = null): (LosEnd | null)[] {
  return [selfEnd(state), ...chain.map((h) => { const r = relayOf(h, state.contacts); return r ? contactEnd(r) : null; }), ...(last ? [last] : [])];
}
