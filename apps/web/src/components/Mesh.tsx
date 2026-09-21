/**
 * Everyone the radio hears, on the map and in a list, in one place. On a
 * phone the list rides in a sheet over the map, pulled up to read it and
 * down to see the map; on a desktop it is the column beside the map.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { AdvType, contactConversation, contactRoute, isConversationType, isFavourite, isNodeType, type ContactRecord, type SessionState } from "@meshnet/meshcore";
import { nameOfHash } from "../lib/echoes.js";
import { ago, agoPhrase } from "../lib/format.js";
import { bearingDeg, compass, distanceKm, formatDistance, hasPosition } from "../lib/geo.js";
import { focusOnMap, openConversation, openProfile, useNav } from "../lib/nav.js";
import { kindLabel } from "../lib/nodes.js";
import { routeWords } from "../lib/routes.js";
import { useSavedPasswords } from "../lib/secrets.js";
import { session, useSession } from "../lib/session.js";
import { act } from "../lib/toast.js";
import { IconButton } from "../ui/Button.js";
import { Avatar } from "./Avatar.js";
import { ChatIcon, CloseIcon, InfoIcon, RefreshIcon, SearchIcon, StarFilledIcon } from "./Icons.js";
import { LOW_BATTERY_MV } from "./node/Status.js";

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

/** The map with the filter applied, the focus drawn, and taps handed up. */
export function MeshMap({ selected, onSelect, onGroup, coverBottom, zoomButtons }: { selected: string | null; onSelect: (key: string | null) => void; onGroup: (keys: string[]) => void; coverBottom?: number | undefined; zoomButtons?: boolean | undefined }) {
  const state = useSession();
  const saved = useSavedPasswords();
  const { kind, query } = useFilter();
  // The map redraws markers when the filter function changes, so it changes only with what it filters by.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const test = useCallback(matcher(state, saved, kind, query), [state.logins, state.statusHistory, saved, kind, query]);
  return (
    <Suspense fallback={<div className="empty muted">Loading the map…</div>}>
      <MapView selected={selected} onSelect={onSelect} onGroup={onGroup} filter={test} coverBottom={coverBottom} zoomButtons={zoomButtons} />
    </Suspense>
  );
}

/** A picked node, in a few lines: who, how far, which way the messages go. */
export function NodeCard({ contactKey, onClose }: { contactKey: string; onClose: () => void }) {
  const state = useSession();
  const c = state.contacts[contactKey];
  if (!c) return null;
  const route = contactRoute(c);
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
      <div className="node-card-route">
        <span className="muted">Route</span>
        {route && route.length > 0 ? (
          <span className="hops">
            {route.map((hash, i) => (
              <span key={i} className={["hop", nameOfHash(hash, state.contacts) ? "" : "amb"].join(" ")}>
                {nameOfHash(hash, state.contacts) ?? `${hash}?`}
              </span>
            ))}
          </span>
        ) : (
          <span>{routeWords(c).text}</span>
        )}
      </div>
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
let lastDetent: Detent = "half";

/** The Mesh tab on a phone: the map, and the list in a sheet with three positions. */
export function MeshPhone() {
  const nav = useNav();
  const state = useSession();
  const box = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [detent, setDetentState] = useState<Detent>(() => (Object.values(state.contacts).some((c) => hasPosition(c.lat, c.lon)) ? lastDetent : "full"));
  const [group, setGroup] = useState<string[] | null>(null);
  const drag = useRef<{ y: number; h: number; moved: boolean } | null>(null);
  const focus = nav.meshFocus && state.contacts[nav.meshFocus] ? nav.meshFocus : null;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const resize = new ResizeObserver(() => setHeight(el.clientHeight));
    resize.observe(el);
    setHeight(el.clientHeight);
    return () => resize.disconnect();
  }, []);

  const heights: Record<Detent, number> = useMemo(() => ({ peek: 116, half: Math.round(Math.max(280, height * 0.46)), full: Math.max(300, height - 8) }), [height]);
  const setDetent = (d: Detent) => {
    lastDetent = d;
    setDetentState(d);
  };

  // A pick shows its card at half height, unless the list was pulled all the way up to read.
  useEffect(() => {
    if (focus && detent === "peek") setDetent("half");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("input, button")) return;
    drag.current = { y: e.clientY, h: sheet.current?.offsetHeight ?? heights[detent], moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    const el = sheet.current;
    if (!d || !el) return;
    const dy = e.clientY - d.y;
    if (Math.abs(dy) > 4) d.moved = true;
    el.style.transition = "none";
    el.style.height = `${Math.max(heights.peek - 20, Math.min(heights.full, d.h - dy))}px`;
  };
  const onUp = () => {
    const d = drag.current;
    const el = sheet.current;
    drag.current = null;
    if (!d || !el) return;
    el.style.transition = "";
    el.style.height = "";
    if (!d.moved) {
      // A tap on the handle steps to the next position.
      setDetent(detent === "peek" ? "half" : detent === "half" ? "full" : "peek");
      return;
    }
    const h = el.offsetHeight;
    const at = (Object.keys(heights) as Detent[]).reduce((a, b) => (Math.abs(heights[b] - h) < Math.abs(heights[a] - h) ? b : a));
    setDetent(at);
  };

  const pick = (key: string | null) => {
    setGroup(null);
    focusOnMap(key);
  };

  return (
    <div className="mesh-phone" ref={box}>
      <MeshMap selected={focus} onSelect={pick} onGroup={(keys) => { setGroup(keys); focusOnMap(null); if (detent === "peek") setDetent("half"); }} coverBottom={heights[detent]} />
      <div ref={sheet} className="mesh-sheet" style={{ height: heights[detent] || undefined }}>
        <div className="mesh-sheet-head" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <div className="sheet-grab" />
          {focus || group ? null : (
            <div className="mesh-sheet-tools">
              <MeshSearchInline onFocus={() => detent === "peek" && setDetent("half")} />
              <FetchButton />
            </div>
          )}
        </div>
        <div className="mesh-sheet-body">
          {focus ? (
            <NodeCard contactKey={focus} onClose={() => pick(null)} />
          ) : group ? (
            <GroupList keys={group} onPick={pick} onClose={() => setGroup(null)} />
          ) : (
            <MeshListBodyNoSearch onOpen={(key) => openProfile(key)} />
          )}
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
      <input value={query} onFocus={onFocus} onChange={(e) => setFilter({ query: e.target.value })} placeholder="Find a node" aria-label="Find a node" />
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
