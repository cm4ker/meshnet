/**
 * Everyone the radio hears, on the map and in a list, in one place. On a
 * phone the list rides in a sheet over the map, pulled up to read it and
 * down to see the map; on a desktop it is the column beside the map.
 */

import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AdvType, contactConversation, isConversationType, isFavourite, isNodeType, type ContactRecord, type SessionState } from "@meshnet/meshcore";
import { useBackLayer } from "../lib/back.js";
import { ago, agoPhrase } from "../lib/format.js";
import { bearingDeg, compass, distanceKm, formatDistance, hasPosition } from "../lib/geo.js";
import { useHears } from "../lib/hears.js";
import { legId, useLegVerdicts } from "../lib/legVerdicts.js";
import type { LinkRadio } from "../lib/los.js";
import { contactEnd, defaultHeight, EMPTY_OVERLAY, editOverlay, hearsOverlay, losOverlay, relayOf, routeOverlay, selfEnd, type MapHandle, type MapOverlay } from "../lib/mapOverlay.js";
import { useMeshTool, type LosEnd } from "../lib/meshTool.js";
import { focusOnMap, openConversation, openProfile, useNav } from "../lib/nav.js";
import { kindLabel } from "../lib/nodes.js";
import { usePing, measuredLegs } from "../lib/ping.js";
import { routeWords } from "../lib/routes.js";
import { useSavedPasswords } from "../lib/secrets.js";
import { session, useSession } from "../lib/session.js";
import { act } from "../lib/toast.js";
import { closeTool, dropOnRoute, lineOfSightTo, openLineOfSight, tapInRoute, whoHearsMe } from "../lib/toolActions.js";
import { getTextScale, subscribeTextSize } from "../theme/textSize.js";
import { IconButton } from "../ui/Button.js";
import { AirMark } from "../ui/List.js";
import { Avatar } from "./Avatar.js";
import { ChatIcon, CloseIcon, InfoIcon, RefreshIcon, SearchIcon, StarFilledIcon, WavesIcon } from "./Icons.js";
import { LOW_BATTERY_MV } from "./node/Status.js";
import { NodeCheck } from "./tools/NodeCheck.js";
import { ToolPanel } from "./tools/ToolPanel.js";

// Leaflet and its styles load with the map, not with the app.
const MapView = lazy(() => import("./MapView.js"));

type Kind = "all" | "yours" | "people" | "repeaters" | "rooms" | "sensors";

const KINDS: { id: Kind; label: string }[] = [
  { id: "all", label: "All" },
  { id: "yours", label: "Yours" },
  { id: "people", label: "People" },
  { id: "repeaters", label: "Repeaters" },
  { id: "rooms", label: "Rooms" },
  { id: "sensors", label: "Sensors" },
];

// ---- the filter, shared by the list and the map, and kept while the app lives ----

let filter: { kind: Kind; query: string } = { kind: "all", query: "" };
const filterListeners = new Set<() => void>();
function setFilter(patch: Partial<typeof filter>): void {
  filter = { ...filter, ...patch };
  for (const listener of filterListeners) listener();
}
function useFilter() {
  return useSyncExternalStore(
    (listener) => {
      filterListeners.add(listener);
      return () => filterListeners.delete(listener);
    },
    () => filter,
  );
}

/** Repeaters, rooms and sensors you have signed in to, asked for their status, or kept a password for. */
function isYours(state: SessionState, saved: readonly string[], c: ContactRecord): boolean {
  return isNodeType(c.type) && (state.logins[c.key] !== undefined || state.statusHistory[c.key] !== undefined || saved.includes(c.key));
}

function matcher(state: SessionState, saved: readonly string[], kind: Kind, query: string): (c: ContactRecord) => boolean {
  const q = query.trim().toLowerCase();
  return (c) => {
    if (q && !(c.name || c.prefix).toLowerCase().includes(q) && !c.key.startsWith(q)) return false;
    switch (kind) {
      case "yours":
        return isYours(state, saved, c);
      case "people":
        return c.type === AdvType.Chat;
      case "repeaters":
        return c.type === AdvType.Repeater;
      case "rooms":
        return c.type === AdvType.Room;
      case "sensors":
        return c.type === AdvType.Sensor;
      default:
        return true;
    }
  };
}

function heard(c: ContactRecord): number {
  return Math.max(c.lastHeardAt ?? 0, c.lastAdvert * 1000);
}

/** A node of yours in trouble: its last status says its battery is low. */
export function lowBattery(state: SessionState, key: string): boolean {
  const last = state.statusHistory[key]?.at(-1);
  return !!last && last.batteryMv > 0 && last.batteryMv < LOW_BATTERY_MV;
}

/** Whether any node of yours needs a look, for the dot on the Mesh tab. */
export function useMeshAttention(): boolean {
  const state = useSession();
  return Object.keys(state.statusHistory).some((key) => state.contacts[key] && lowBattery(state, key));
}

function whereFrom(state: SessionState, c: ContactRecord): string | null {
  const self = state.self;
  if (!hasPosition(c.lat, c.lon)) return null;
  if (!self || !hasPosition(self.lat, self.lon)) return null;
  return `${formatDistance(distanceKm(self.lat, self.lon, c.lat, c.lon))} ${compass(bearingDeg(self.lat, self.lon, c.lat, c.lon))}`;
}

// ---- the list ----

export function MeshList({ selected, onOpen, head = true, only }: { selected: string | null; onOpen: (key: string) => void; head?: boolean | undefined; only?: string[] | undefined }) {
  return (
    <div className="list-pane">
      {head ? <MeshListHead /> : null}
      <MeshListBody selected={selected} onOpen={onOpen} only={only} hideSearch={!!only} />
    </div>
  );
}

export function MeshListHead() {
  return (
    <header className="list-head">
      <h1>Mesh</h1>
      <FetchButton />
    </header>
  );
}

function FetchButton() {
  const online = useSession().status === "ready";
  const [busy, setBusy] = useState(false);
  return (
    <IconButton
      label="Fetch every contact from the radio"
      disabled={busy || !online}
      onClick={async () => {
        setBusy(true);
        await act(() => session.refreshContacts(true), "Contacts fetched from the radio");
        setBusy(false);
      }}
    >
      <RefreshIcon size={17} className={busy ? "spin" : ""} />
    </IconButton>
  );
}

function MeshSearch() {
  const { query } = useFilter();
  return (
    <label className="search">
      <SearchIcon size={15} />
      <input value={query} onChange={(e) => setFilter({ query: e.target.value })} placeholder="Find a node" aria-label="Find a node" data-find />
    </label>
  );
}

function MeshListBody({ selected, onOpen, hideSearch = false, only }: { selected: string | null; onOpen: (key: string) => void; hideSearch?: boolean | undefined; only?: string[] | undefined }) {
  const state = useSession();
  const saved = useSavedPasswords();
  const { kind, query } = useFilter();
  const all = Object.values(state.contacts);
  const rows = all.filter(only ? (c) => only.includes(c.key) : matcher(state, saved, kind, query)).sort((a, b) => heard(b) - heard(a) || (a.name || a.prefix).localeCompare(b.name || b.prefix));
  const yours = rows.filter((c) => isYours(state, saved, c));
  const favourites = rows.filter((c) => !isYours(state, saved, c) && isFavourite(c));
  const rest = rows.filter((c) => !isYours(state, saved, c) && !isFavourite(c));
  const unplaced = all.filter((c) => !hasPosition(c.lat, c.lon)).length;

  const group = (title: string, list: ContactRecord[]) =>
    list.length ? (
      <>
        <div className="list-group">{title}</div>
        <ul className="list-rows" role="list">
          {list.map((c) => (
            <NodeRow key={c.key} contact={c} selected={selected === c.key} yours={title === "Yours"} onOpen={onOpen} />
          ))}
        </ul>
      </>
    ) : null;

  return (
    <>
      {hideSearch ? null : <MeshSearch />}
      <div className="chips" role="group" aria-label="Show" hidden={!!only}>
        {KINDS.map((k) => (
          <button key={k.id} type="button" className={["chip", kind === k.id ? "on" : ""].join(" ")} aria-pressed={kind === k.id} onClick={() => setFilter({ kind: k.id })}>
            {k.label}
          </button>
        ))}
      </div>
      {only ? null : (
        <button type="button" className="hears-row" disabled={state.status !== "ready"} onClick={whoHearsMe}>
          <WavesIcon size={17} />
          <span className="grow">Who hears me</span>
          <AirMark />
        </button>
      )}
      <div className="list mesh-list">
        {all.length === 0 ? (
          <div className="empty muted">Nobody heard yet. Advertise from the Radio tab: neighbours answer with their own adverts.</div>
        ) : rows.length === 0 ? (
          <div className="empty muted">{kind === "yours" && !query ? "Repeaters, rooms and sensors you sign in to gather here." : "Nothing matches."}</div>
        ) : (
          <>
            <div className="list-summary muted">
              {all.length} {all.length === 1 ? "node" : "nodes"}
              {unplaced ? ` · ${unplaced} without position` : ""}
            </div>
            {group("Yours", yours)}
            {group("Favourites", favourites)}
            {group(yours.length || favourites.length ? "Heard recently" : "", rest)}
          </>
        )}
      </div>
    </>
  );
}

function NodeRow({ contact: c, selected, yours, onOpen }: { contact: ContactRecord; selected: boolean; yours: boolean; onOpen: (key: string) => void }) {
  const state = useSession();
  const login = state.logins[c.key];
  const last = state.statusHistory[c.key]?.at(-1);
  const low = lowBattery(state, c.key);
  const bits = yours
    ? [kindLabel(c.type), login?.ok ? "signed in" : "not signed in", last ? `${(last.batteryMv / 1000).toFixed(2)} V` : null]
    : [kindLabel(c.type), routeWords(c).text, whereFrom(state, c) ?? (hasPosition(c.lat, c.lon) ? null : "no position")];
  return (
    <li>
      <button type="button" className={["row", selected ? "selected" : ""].join(" ")} onClick={() => onOpen(c.key)}>
        <Avatar name={c.name || c.prefix} type={c.type} size={40} />
        <span className="row-main">
          <span className="row-top">
            <span className="row-title">
              {c.name || c.prefix}
              {isFavourite(c) ? <StarFilledIcon size={11} className="star" /> : null}
            </span>
            <span className="row-when muted">{ago(heard(c) || null)}</span>
          </span>
          <span className="row-bottom">
            <span className="row-sub muted">{bits.filter(Boolean).join(" · ")}</span>
            {yours ? <span className={["dot", low ? "warn" : last ? "on" : "stale"].join(" ")} title={low ? "Battery low" : last ? "Healthy at the last status" : "No status yet"} /> : null}
          </span>
        </span>
      </button>
    </li>
  );
}

// ---- the map ----

/**
 * What goes over the nodes: the tool in use, or else the route to the node
 * picked, coloured by its last ping.
 */
function useMeshOverlay(selected: string | null, state: SessionState): MapOverlay {
  const tool = useMeshTool();
  const ping = usePing(tool?.kind === "route" ? tool.key : selected);
  const hears = useHears();
  const self = state.self;
  const radio: LinkRadio | null = useMemo(
    () => (self ? { frequencyKhz: self.frequencyKhz, bandwidthHz: self.bandwidthHz, spreadingFactor: self.spreadingFactor, codingRate: self.codingRate, txPowerDbm: self.txPower } : null),
    [self],
  );
  // A route being changed marks the legs the terrain closes; they are read once and kept.
  const editLegs = useMemo(() => {
    if (tool?.kind !== "route") return [];
    const target = state.contacts[tool.key];
    const ends: (LosEnd | null)[] = [selfEnd(state), ...tool.relays.map((k) => { const r = state.contacts[k] ?? relayOf(k, state.contacts); return r ? contactEnd(r) : null; }), target ? contactEnd(target) : null];
    return ends.slice(1).flatMap((b, i) => {
      const a = ends[i];
      return a && b ? [{ a, b, ha: defaultHeight(a, state.contacts), hb: defaultHeight(b, state.contacts) }] : [];
    });
  }, [tool, state]);
  const verdicts = useLegVerdicts(editLegs, radio);
  const blockedKey = editLegs.filter((l) => verdicts.get(legId(l.a, l.b)) === "blocked").map((l) => legId(l.a, l.b)).join(";");
  const overlay =
    tool?.kind === "los"
      ? losOverlay(tool)
      : tool?.kind === "route"
        ? editOverlay(tool, state, new Set(blockedKey ? blockedKey.split(";") : []), ping)
        : tool?.kind === "hears"
          ? hearsOverlay(hears, state)
          : selected
            ? routeOverlay(selected, state, ping)
            : EMPTY_OVERLAY;
  // The state changes with every packet heard; the lines are drawn again only when they change.
  const same = JSON.stringify(overlay);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => overlay, [same]);
}

/** The map with the filter applied, the focus and the tool drawn, and taps handed up or to the tool. */
export function MeshMap({ selected, onSelect, onGroup, coverTop, coverBottom, zoomButtons }: { selected: string | null; onSelect: (key: string | null) => void; onGroup: (keys: string[]) => void; coverTop?: number | undefined; coverBottom?: number | undefined; zoomButtons?: boolean | undefined }) {
  const state = useSession();
  const saved = useSavedPasswords();
  const { kind, query } = useFilter();
  const tool = useMeshTool();
  const ping = usePing(selected);
  const overlay = useMeshOverlay(selected, state);
  // The map redraws markers when the filter function changes, so it changes only with what it filters by.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const test = useCallback(matcher(state, saved, kind, query), [state.logins, state.statusHistory, saved, kind, query]);
  const pick = (key: string | null) => {
    if (tapInRoute(key, state)) return;
    // A tap on the empty map puts a line of sight away, as it puts away a picked node.
    if (key === null && tool && tool.kind !== "route") closeTool();
    onSelect(key);
  };
  const leg = (from: LosEnd, to: LosEnd) => {
    // The legs of a pinged route carry what the ping measured on them.
    const back = tool?.kind === "los" ? tool.back : selected;
    let heard: [number, number] | null = null;
    if (!tool && selected && ping) {
      const relays = ping.targetInChain ? ping.chain.slice(0, -1) : ping.chain;
      const keys = ["self", ...relays.map((h) => relayOf(h, state.contacts)?.key ?? h), selected];
      const index = keys.findIndex((k, i) => k === from.key && keys[i + 1] === to.key);
      heard = index >= 0 ? (measuredLegs(ping)[index] ?? null) : null;
    }
    openLineOfSight(from, to, tool?.kind === "hears" ? null : back, heard);
  };
  const drop = (handle: MapHandle, onto: string) => {
    const key = tool?.kind === "route" ? tool.key : selected;
    if (key) dropOnRoute(key, handle, onto);
  };
  return (
    <Suspense fallback={<div className="empty muted">Loading the map…</div>}>
      <MapView selected={selected} onSelect={pick} onGroup={onGroup} filter={test} coverTop={coverTop} coverBottom={coverBottom} zoomButtons={zoomButtons} overlay={overlay} onLeg={leg} onHold={lineOfSightTo} onHandleDrop={drop} />
    </Suspense>
  );
}

/** A picked node, in a few lines: who, how far, which way the messages go, and a ping along that way. */
export function NodeCard({ contactKey, onClose }: { contactKey: string; onClose: () => void }) {
  const state = useSession();
  const c = state.contacts[contactKey];
  if (!c) return null;
  const where = whereFrom(state, c);
  return (
    <div className="node-card">
      <div className="node-card-head">
        <Avatar name={c.name || c.prefix} type={c.type} size={40} />
        <span className="row-main">
          <span className="row-title">{c.name || c.prefix}</span>
          <span className="row-sub muted">{[kindLabel(c.type), where, c.lastAdvert > 0 ? `advert ${agoPhrase(c.lastAdvert * 1000)}` : null].filter(Boolean).join(" · ")}</span>
        </span>
        <IconButton label="Close the card" onClick={onClose}>
          <CloseIcon size={18} />
        </IconButton>
      </div>
      <NodeCheck contactKey={c.key} />
      <div className="hero-actions">
        {isConversationType(c.type) ? (
          <button type="button" className="hero-act primary" onClick={() => openConversation(contactConversation(c.key))}>
            <ChatIcon size={20} />
            Message
          </button>
        ) : null}
        <button type="button" className="hero-act" onClick={() => openProfile(c.key)}>
          <InfoIcon size={20} />
          Profile
        </button>
      </div>
    </div>
  );
}

/** Nodes at one spot, which no zoom separates. */
function GroupList({ keys, onPick, onClose }: { keys: string[]; onPick: (key: string) => void; onClose: () => void }) {
  const state = useSession();
  const members = keys.map((k) => state.contacts[k]).filter((c): c is ContactRecord => !!c);
  return (
    <div className="node-card">
      <div className="node-card-head">
        <span className="row-main">
          <span className="row-title">{members.length} nodes at one spot</span>
          <span className="row-sub muted">{members[0] ? whereFrom(state, members[0]) ?? "" : ""}</span>
        </span>
        <IconButton label="Close" onClick={onClose}>
          <CloseIcon size={18} />
        </IconButton>
      </div>
      <ul className="list-rows" role="list">
        {members.map((c) => (
          <li key={c.key}>
            <button type="button" className="row" onClick={() => onPick(c.key)}>
              <Avatar name={c.name || c.prefix} type={c.type} size={32} />
              <span className="row-main">
                <span className="row-title">{c.name || c.prefix}</span>
                <span className="row-sub muted">{kindLabel(c.type)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- the phone ----

type Detent = "peek" | "half" | "full";
const DETENTS: Detent[] = ["peek", "half", "full"];
let lastDetent: Detent = "half";

/** A release faster than this, in pixels a millisecond, carries the sheet on to the next position that way. */
const FLICK = 0.4;
/** Below its lowest position the sheet still follows the finger, but only this share of the way. */
const OVERPULL = 0.3;

/**
 * The Mesh tab on a phone: the map, and the list in a sheet with three
 * positions. The sheet keeps its full height and slides, so following a
 * finger moves one layer instead of laying the list out again every frame.
 * It is pulled by its handle, or by the list itself wherever the list is not
 * scrolling: anywhere below the top position, and down from the list's top.
 */
export function MeshPhone({ hidden = false }: { hidden?: boolean | undefined }) {
  const nav = useNav();
  const state = useSession();
  const box = useRef<HTMLDivElement>(null);
  const inset = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  // The box's height, how much of its top the notch or the status bar takes, where the chips end in
  // the sheet, and how tall a picked node's card is.
  const [space, setSpace] = useState({ height: 0, top: 0, peek: 0, card: 0 });
  const [detent, setDetentState] = useState<Detent>(() => (Object.values(state.contacts).some((c) => hasPosition(c.lat, c.lon)) ? lastDetent : "full"));
  const [group, setGroup] = useState<string[] | null>(null);
  const tool = useMeshTool();
  const focus = nav.meshFocus && state.contacts[nav.meshFocus] ? nav.meshFocus : null;
  const listed = !focus && !group && !tool;
  const setDetent = (d: Detent) => {
    lastDetent = d;
    setDetentState(d);
  };

  // Back puts away what covers the map: the list of nodes at one spot, or the list pulled all the way up.
  const mapped = Object.values(state.contacts).some((c) => hasPosition(c.lat, c.lon));
  useBackLayer(!hidden && group !== null, () => setGroup(null));
  useBackLayer(!hidden && listed && mapped && detent === "full", () => setDetent("half"));
  useBackLayer(!hidden && tool !== null, closeTool);

  // A pick shows its card at half height, over the map, even when the list was up to read: "On map" in a
  // profile comes here. Decided while rendering, so the map learns in the same pass how much the sheet covers.
  const [picked, setPicked] = useState(focus);
  if (picked !== focus) {
    setPicked(focus);
    if (focus && detent !== "half") setDetent("half");
  }
  // A tool opens over the map at its own height, like a card.
  const [shownTool, setShownTool] = useState(tool?.kind ?? null);
  if (shownTool !== (tool?.kind ?? null)) {
    setShownTool(tool?.kind ?? null);
    if (tool && detent !== "half") setDetent("half");
  }

  useLayoutEffect(() => {
    const el = box.current;
    const probe = inset.current;
    if (!el || !probe) return;
    const measure = () => {
      const height = el.clientHeight;
      const top = probe.offsetHeight;
      // Hidden under a profile the box has no height; what it had is what it will have again.
      if (height === 0) return;
      setSpace((s) => (s.height === height && s.top === top ? s : { ...s, height, top }));
    };
    const resize = new ResizeObserver(measure);
    resize.observe(el);
    resize.observe(probe);
    measure();
    return () => resize.disconnect();
  }, []);

  // The lowest position shows the search and the chips, and stops before the first line of the list.
  // A new text size moves where the chips end; hidden, the sheet has nowhere to measure.
  const textScale = useSyncExternalStore(subscribeTextSize, getTextScale);
  useLayoutEffect(() => {
    const el = sheet.current;
    const scroller = body.current;
    const chips = listed ? scroller?.querySelector<HTMLElement>(".chips") : null;
    if (!el || !scroller || !chips || space.height === 0 || hidden) return;
    const peek = Math.round(chips.getBoundingClientRect().bottom - el.getBoundingClientRect().top + scroller.scrollTop);
    setSpace((s) => (s.peek === peek ? s : { ...s, peek }));
  }, [listed, space.height, hidden, textScale]);

  // A card sits at its own height instead of the list's middle one, so more of the map shows around it.
  useLayoutEffect(() => {
    const el = sheet.current;
    const card = listed ? null : body.current?.firstElementChild;
    if (!el || !card) return;
    const measure = () => {
      const h = Math.round(card.getBoundingClientRect().bottom - el.getBoundingClientRect().top + (body.current?.scrollTop ?? 0));
      setSpace((s) => (s.card === h ? s : { ...s, card: h }));
    };
    const resize = new ResizeObserver(measure);
    resize.observe(card);
    measure();
    return () => resize.disconnect();
  }, [listed, focus, group, tool?.kind]);

  const full = Math.max(0, space.height - space.top - 8);
  const middle = Math.max(0, Math.min(full - 48, Math.max(240, Math.round(space.height * 0.46))));
  const peek = Math.max(0, Math.min(middle - 48, space.peek || 104));
  const half = !listed && space.card ? Math.max(peek + 48, Math.min(middle, space.card)) : middle;
  const heights: Record<Detent, number> = { peek, half, full };

  // What the handlers read, so the listeners on the list are set once.
  const live = useRef({ detent, heights, setDetent });
  live.current = { detent, heights, setDetent };

  const motion = useMemo(() => {
    let drag: { from: number; h: number; now: number; moved: boolean; trail: { y: number; t: number }[] } | null = null;
    const place = (el: HTMLElement, h: number) => {
      el.style.transform = `translate3d(0, ${live.current.heights.full - h}px, 0)`;
    };
    const begin = (y: number) => {
      const el = sheet.current;
      if (!el) return;
      const { detent, heights } = live.current;
      // Caught while it is still settling, the sheet is taken from where it is.
      const shift = new DOMMatrixReadOnly(getComputedStyle(el).transform).m42;
      const h = Number.isFinite(shift) ? heights.full - shift : heights[detent];
      drag = { from: y, h, now: h, moved: false, trail: [{ y, t: performance.now() }] };
      el.style.transition = "none";
      place(el, h);
    };
    const follow = (y: number) => {
      const el = sheet.current;
      if (!drag || !el) return;
      const { heights } = live.current;
      const t = performance.now();
      drag.trail.push({ y, t });
      while (drag.trail.length > 2 && t - drag.trail[0]!.t > 100) drag.trail.shift();
      if (Math.abs(y - drag.from) > 4) drag.moved = true;
      let h = Math.min(heights.full, drag.h - (y - drag.from));
      if (h < heights.peek) h = heights.peek - (heights.peek - h) * OVERPULL;
      drag.now = h;
      place(el, h);
    };
    /**
     * Lets go at the position the sheet was flung towards, or else the nearest; a tap on the handle
     * steps on to the next.
     */
    const release = (tap: boolean) => {
      const d = drag;
      const el = sheet.current;
      drag = null;
      if (!d || !el) return;
      const { detent, heights, setDetent } = live.current;
      let target: Detent = detent;
      if (!d.moved) {
        if (tap) target = detent === "peek" ? "half" : detent === "half" ? "full" : "peek";
      } else {
        const first = d.trail[0]!;
        const last = d.trail.at(-1)!;
        // A finger that stopped before it lifted flings nothing.
        const v = performance.now() - last.t < 80 && last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0;
        if (v < -FLICK) target = DETENTS.find((k) => heights[k] > d.now + 2) ?? "full";
        else if (v > FLICK) target = [...DETENTS].reverse().find((k) => heights[k] < d.now - 2) ?? "peek";
        else target = DETENTS.reduce((a, b) => (Math.abs(heights[b] - d.now) < Math.abs(heights[a] - d.now) ? b : a));
      }
      el.style.transition = "";
      place(el, heights[target]);
      setDetent(target);
    };
    return { begin, follow, release };
  }, []);

  // The list pulls the sheet by touch; a mouse has the handle and the wheel.
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    let start: { x: number; y: number } | null = null;
    let dragging = false;
    // How far the finger went, from where it came down.
    let from = 0;
    let travel = 0;
    const swallow = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
    };
    const down = (e: TouchEvent) => {
      const t = e.touches[0];
      start = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : null;
      if (e.touches.length > 1 && dragging) {
        dragging = false;
        motion.release(false);
      }
    };
    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      if (start) {
        const dx = t.clientX - start.x;
        const dy = t.clientY - start.y;
        if (!dx && !dy) return;
        from = start.y;
        travel = 0;
        start = null;
        // Decided on the first move, while the page can still be told not to scroll. Sideways scrolls
        // the chips; at the top position the list scrolls, unless it is pulled down from its top.
        if (Math.abs(dx) > Math.abs(dy)) return;
        if (live.current.detent === "full" && (dy < 0 || el.scrollTop > 0)) return;
        dragging = true;
        motion.begin(from);
      }
      if (!dragging) return;
      e.preventDefault();
      travel = Math.max(travel, Math.abs(t.clientY - from));
      motion.follow(t.clientY);
    };
    const up = () => {
      start = null;
      if (!dragging) return;
      dragging = false;
      motion.release(false);
      // A pull that ends over a row does not open it; a tap whose finger shook a little still does.
      if (travel <= 10) return;
      el.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => el.removeEventListener("click", swallow, { capture: true }), 400);
    };
    el.addEventListener("touchstart", down, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", up);
    el.addEventListener("touchcancel", up);
    return () => {
      el.removeEventListener("touchstart", down);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", up);
      el.removeEventListener("touchcancel", up);
    };
  }, [motion]);

  const pick = (key: string | null) => {
    setGroup(null);
    focusOnMap(key);
  };

  return (
    <div className="mesh-phone" ref={box} hidden={hidden} data-detent={detent}>
      <div className="mesh-inset" ref={inset} aria-hidden="true" />
      {/* Not before the sheet is measured, so the map's first view is fitted to the part left uncovered. */}
      {space.height ? (
        <MeshMap
          selected={focus}
          onSelect={pick}
          onGroup={(keys) => {
            setGroup(keys);
            focusOnMap(null);
            if (detent !== "half") setDetent("half");
          }}
          coverTop={space.top}
          coverBottom={heights[detent]}
        />
      ) : null}
      <div ref={sheet} className="mesh-sheet" style={{ height: full, transform: `translate3d(0, ${full - heights[detent]}px, 0)` }}>
        <div
          className="mesh-sheet-head"
          onPointerDown={(e) => {
            if (e.button !== 0 || (e.target as HTMLElement).closest("input, button, label")) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            motion.begin(e.clientY);
          }}
          onPointerMove={(e) => motion.follow(e.clientY)}
          onPointerUp={() => motion.release(true)}
          onPointerCancel={() => motion.release(false)}
        >
          <div className="sheet-grab" />
          {listed ? (
            <div className="mesh-sheet-tools">
              <MeshSearchInline onFocus={() => detent !== "full" && setDetent("full")} />
              <FetchButton />
            </div>
          ) : null}
        </div>
        <div className="mesh-sheet-body" ref={body}>
          {tool ? (
            <ToolPanel tool={tool} />
          ) : focus ? (
            <NodeCard contactKey={focus} onClose={() => pick(null)} />
          ) : group ? (
            <GroupList keys={group} onPick={pick} onClose={() => setGroup(null)} />
          ) : (
            <MeshListBodyNoSearch onOpen={(key) => openProfile(key)} />
          )}
          {/* The part of the sheet below the screen's edge, so the end of the list can be scrolled into view. */}
          <div aria-hidden="true" style={{ height: full - heights[detent] }} />
        </div>
      </div>
    </div>
  );
}

function MeshSearchInline({ onFocus }: { onFocus: () => void }) {
  const { query } = useFilter();
  return (
    <label className="search">
      <SearchIcon size={15} />
      <input value={query} onFocus={onFocus} onChange={(e) => setFilter({ query: e.target.value })} placeholder="Find a node" aria-label="Find a node" enterKeyHint="search" />
    </label>
  );
}

/** The list without its own search field: in the sheet, the field sits in the handle. */
function MeshListBodyNoSearch({ onOpen }: { onOpen: (key: string) => void }) {
  return (
    <div className="mesh-sheet-list">
      <MeshListBody selected={null} onOpen={onOpen} hideSearch />
    </div>
  );
}
