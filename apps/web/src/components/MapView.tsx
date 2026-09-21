/**
 * The nodes on a map: every contact whose last advert carried a position, and
 * this radio. Tiles are OpenStreetMap's, kept on the device as they are seen
 * (lib/tiles.ts). Nodes that would overlap at the current zoom are gathered
 * into one circle with their count (lib/cluster.ts); tapping it zooms in on
 * them, or lists them when they share a spot. Picking a node shows how far
 * and which way it is, and draws the route the radio holds to it through the
 * relays whose position is known. Nothing here asks the air for anything.
 */

import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { AdvType, contactConversation, contactRoute, contactTypeName, isConversationType, type ContactRecord } from "@meshnet/meshcore";
import { clusterPoints, type Placed } from "../lib/cluster.js";
import { darkenPixels } from "../lib/darkTile.js";
import { candidatesOfHash, nameOfHash } from "../lib/echoes.js";
import { ago, hue } from "../lib/format.js";
import { bearingDeg, compass, distanceKm, formatDistance, freshness, hasPosition } from "../lib/geo.js";
import { openContact, openConversation } from "../lib/nav.js";
import { useSession } from "../lib/session.js";
import { TILE_ATTRIBUTION, TILE_URL, tileBlob } from "../lib/tiles.js";
import { Button, IconButton } from "../ui/Button.js";
import { Avatar } from "./Avatar.js";
import { FitIcon, LocateIcon, MinusIcon, PlusIcon } from "./Icons.js";

function darkTheme(): boolean {
  return document.documentElement.dataset["appearance"] === "dark";
}

function decode(blob: Blob): Promise<CanvasImageSource & { close?: () => void }> {
  if (typeof createImageBitmap === "function") return createImageBitmap(blob);
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("tile did not decode"));
    };
    img.src = url;
  });
}

/**
 * Serves each tile from the device's copy when it has one (lib/tiles.ts), and
 * draws it on a canvas, recoloured once for a dark theme (lib/darkTile.ts)
 * rather than filtered live on every frame of a zoom.
 */
class CachedTileLayer extends L.TileLayer {
  protected override createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
    const canvas = document.createElement("canvas");
    canvas.setAttribute("role", "presentation");
    const size = this.getTileSize();
    canvas.width = size.x;
    canvas.height = size.y;
    tileBlob(this.getTileUrl(coords))
      .then(decode)
      .then((image) => {
        const dark = darkTheme();
        const context = canvas.getContext("2d", { willReadFrequently: dark });
        if (!context) throw new Error("no canvas");
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        image.close?.();
        if (dark) {
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
          darkenPixels(pixels.data);
          context.putImageData(pixels, 0, 0);
        }
        done(undefined, canvas);
      })
      .catch((error: Error) => done(error, canvas));
    return canvas;
  }
}

type Filter = "all" | typeof AdvType.Repeater | typeof AdvType.Chat | typeof AdvType.Room | typeof AdvType.Sensor;

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: AdvType.Repeater, label: "Repeaters" },
  { id: AdvType.Chat, label: "People" },
  { id: AdvType.Room, label: "Rooms" },
  { id: AdvType.Sensor, label: "Sensors" },
];

interface Point {
  lat: number;
  lon: number;
}

/** Room for the filter chips above, the controls to the right and the sheet below, so no marker is fitted under them. */
const FIT_PADDING: L.FitBoundsOptions = { paddingTopLeft: [40, 96], paddingBottomRight: [64, 160] };

/** How close, in screen pixels, two markers may come before they are gathered: a marker and its name. */
const CLUSTER_RADIUS = 44;

/** A group spread less than this, in metres, is the same spot at any zoom, and is listed rather than zoomed into. */
const SAME_SPOT_M = 25;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function glyph(contact: ContactRecord): string {
  if (contact.type === AdvType.Repeater) return "";
  if (contact.type === AdvType.Room) return "#";
  if (contact.type === AdvType.Sensor) return "";
  return escapeHtml((contact.name || contact.prefix).slice(0, 1).toUpperCase());
}

/** What a node's marker shows, as a string: a marker is redrawn only when this changes. */
function nodeLook(contact: ContactRecord, nowSec: number, selected: boolean): { look: string; make: () => L.DivIcon } {
  const age = contact.lastAdvert > 0 ? nowSec - contact.lastAdvert : Number.POSITIVE_INFINITY;
  const state = freshness(contact.type, age);
  const name = escapeHtml(contact.name || contact.prefix);
  const stale = state === "stale" && Number.isFinite(age) ? ` · ${ago(contact.lastAdvert * 1000)}` : "";
  const className = ["map-node", `t-${contact.type}`, state, selected ? "sel" : ""].join(" ");
  const html = `<span class="map-pin" style="--hue:${hue(contact.name || contact.prefix)}">${glyph(contact)}</span><span class="map-name">${name}${stale}</span>`;
  return {
    look: className + html,
    make: () => L.divIcon({ className, html, iconSize: [22, 22], iconAnchor: [11, 11] }),
  };
}

function groupLook(members: ContactRecord[], selected: boolean): { look: string; make: () => L.DivIcon } {
  const n = members.length;
  const size = n < 10 ? 32 : n < 100 ? 38 : 44;
  const className = ["map-group", selected ? "sel" : ""].join(" ");
  return {
    look: `${className}|${n}`,
    make: () => L.divIcon({ className, html: `<span class="map-group-count">${n}</span>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
  };
}

function selfIcon(name: string): L.DivIcon {
  return L.divIcon({
    className: "map-self",
    html: `<span class="map-self-pulse"></span><span class="map-self-dot"></span><span class="map-name">${escapeHtml(name)}</span>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

/** The points the route to a contact passes: us, each relay whose position is known and unambiguous, the contact. */
function routePoints(contact: ContactRecord, contacts: Record<string, ContactRecord>, self: Point | null): Point[] | null {
  const hashes = contactRoute(contact);
  if (hashes === null) return null;
  const points: Point[] = self ? [self] : [];
  for (const hash of hashes) {
    const candidates = candidatesOfHash(hash, contacts);
    const relay = candidates.length === 1 ? candidates[0]! : null;
    if (relay && hasPosition(relay.lat, relay.lon)) points.push({ lat: relay.lat, lon: relay.lon });
  }
  points.push({ lat: contact.lat, lon: contact.lon });
  return points.length >= 2 ? points : null;
}

interface Shown {
  marker: L.Marker;
  look: string;
  /** A group's members; the click handler reads them from here, so it never holds a stale list. */
  members: ContactRecord[];
}

export default function MapView() {
  const state = useSession();
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const nodesLayer = useRef<L.LayerGroup | null>(null);
  const routeLayer = useRef<L.LayerGroup | null>(null);
  const selfMarker = useRef<L.Marker | null>(null);
  const markers = useRef(new Map<string, Shown>());
  const fitted = useRef(false);
  const [zoom, setZoom] = useState(2);
  const [selected, setSelected] = useState<string | null>(null);
  const [group, setGroup] = useState<ContactRecord[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [showUnplaced, setShowUnplaced] = useState(false);

  const contacts = state.contacts;
  const selfLat = state.self && hasPosition(state.self.lat, state.self.lon) ? state.self.lat : null;
  const selfLon = selfLat !== null ? state.self!.lon : null;
  const self = useMemo(() => (selfLat !== null && selfLon !== null ? { lat: selfLat, lon: selfLon } : null), [selfLat, selfLon]);
  const selfName = state.self?.name ?? "This radio";

  const { placed, unplaced } = useMemo(() => {
    const all = Object.values(contacts);
    return {
      placed: all.filter((c) => hasPosition(c.lat, c.lon)).sort((a, b) => (a.key < b.key ? -1 : 1)),
      unplaced: all.filter((c) => !hasPosition(c.lat, c.lon)),
    };
  }, [contacts]);
  const shown = useMemo(() => placed.filter((c) => filter === "all" || c.type === filter), [placed, filter]);
  const picked = selected ? contacts[selected] ?? null : null;

  // The map itself, once.
  useEffect(() => {
    if (!box.current) return;
    const m = L.map(box.current, { zoomControl: false, attributionControl: false, worldCopyJump: true, minZoom: 2, maxZoom: 19 });
    L.control.attribution({ prefix: false, position: "topright" }).addTo(m);
    const tiles = new CachedTileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(m);
    routeLayer.current = L.layerGroup().addTo(m);
    nodesLayer.current = L.layerGroup().addTo(m);
    m.setView([20, 0], 2);
    m.on("click", () => {
      setSelected(null);
      setGroup(null);
    });
    m.on("zoomend", () => setZoom(m.getZoom()));
    map.current = m;
    // The pane is sized by the layout, which changes when a phone turns or a desktop window is resized.
    const resize = new ResizeObserver(() => m.invalidateSize());
    resize.observe(box.current);
    // Tiles are coloured when drawn, so a change of theme draws them again.
    const theme = new MutationObserver(() => tiles.redraw());
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-appearance"] });
    const shownMarkers = markers.current;
    return () => {
      theme.disconnect();
      resize.disconnect();
      m.remove();
      map.current = null;
      nodesLayer.current = null;
      routeLayer.current = null;
      selfMarker.current = null;
      shownMarkers.clear();
      fitted.current = false;
    };
  }, []);

  // The markers: gathered for the zoom, then only what changed is touched.
  useEffect(() => {
    const m = map.current;
    const layer = nodesLayer.current;
    if (!m || !layer) return;
    const nowSec = Date.now() / 1000;
    const z = m.getZoom();
    const points: Placed<ContactRecord>[] = shown.map((c) => {
      const p = m.project([c.lat, c.lon], z);
      return { item: c, x: p.x, y: p.y };
    });
    const wanted = new Map<string, { at: L.LatLng; look: string; make: () => L.DivIcon; members: ContactRecord[] }>();
    for (const g of clusterPoints(points, CLUSTER_RADIUS)) {
      if (g.members.length === 1) {
        const c = g.members[0]!;
        wanted.set(c.key, { at: L.latLng(c.lat, c.lon), ...nodeLook(c, nowSec, c.key === selected), members: g.members });
      } else {
        const id = `g:${g.members.map((c) => c.key.slice(0, 16)).join(",")}`;
        const holdsPick = g.members.some((c) => c.key === selected);
        wanted.set(id, { at: m.unproject([g.x, g.y], z), ...groupLook(g.members, holdsPick), members: g.members });
      }
    }

    const current = markers.current;
    for (const [id, shownMarker] of current) {
      if (wanted.has(id)) continue;
      layer.removeLayer(shownMarker.marker);
      current.delete(id);
    }
    for (const [id, want] of wanted) {
      const existing = current.get(id);
      if (existing) {
        if (!existing.marker.getLatLng().equals(want.at)) existing.marker.setLatLng(want.at);
        if (existing.look !== want.look) {
          existing.marker.setIcon(want.make());
          existing.look = want.look;
        }
        existing.members = want.members;
        continue;
      }
      const entry: Shown = { marker: L.marker(want.at, { icon: want.make(), keyboard: true }), look: want.look, members: want.members };
      entry.marker.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        if (entry.members.length === 1) {
          setGroup(null);
          setSelected(entry.members[0]!.key);
          return;
        }
        const bounds = L.latLngBounds(entry.members.map((c) => [c.lat, c.lon] as L.LatLngTuple));
        const spread = bounds.getNorthEast().distanceTo(bounds.getSouthWest());
        if (spread < SAME_SPOT_M || m.getZoom() >= m.getMaxZoom()) {
          setSelected(null);
          setGroup(entry.members);
        } else {
          m.fitBounds(bounds, { ...FIT_PADDING, maxZoom: m.getMaxZoom() });
        }
      });
      entry.marker.addTo(layer);
      current.set(id, entry);
    }
  }, [shown, selected, zoom]);

  // This radio, kept as one marker so its pulse is not restarted by every change.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (!self) {
      selfMarker.current?.remove();
      selfMarker.current = null;
      return;
    }
    if (!selfMarker.current) {
      selfMarker.current = L.marker([self.lat, self.lon], { icon: selfIcon(selfName), interactive: false, zIndexOffset: 1000 }).addTo(m);
    } else {
      selfMarker.current.setLatLng([self.lat, self.lon]);
      selfMarker.current.setIcon(selfIcon(selfName));
    }
  }, [self, selfName]);

  // The route to the picked node.
  useEffect(() => {
    const layer = routeLayer.current;
    if (!layer) return;
    layer.clearLayers();
    if (!picked || !hasPosition(picked.lat, picked.lon)) return;
    const points = routePoints(picked, contacts, self);
    if (points) {
      L.polyline(
        points.map((p) => [p.lat, p.lon] as L.LatLngTuple),
        { className: "map-route", weight: 3, dashArray: "6 8", interactive: false },
      ).addTo(layer);
    }
  }, [picked, contacts, self]);

  // The first time there is something to show, show all of it.
  useEffect(() => {
    const m = map.current;
    if (!m || fitted.current) return;
    const points: L.LatLngTuple[] = placed.map((c) => [c.lat, c.lon]);
    if (self) points.push([self.lat, self.lon]);
    if (points.length === 1) m.setView(points[0]!, 13);
    else if (points.length > 1) m.fitBounds(L.latLngBounds(points), { ...FIT_PADDING, maxZoom: 14 });
    if (points.length > 0) {
      fitted.current = true;
      setZoom(m.getZoom());
    }
  }, [placed, self]);

  const fitAll = () => {
    const points: L.LatLngTuple[] = shown.map((c) => [c.lat, c.lon]);
    if (self) points.push([self.lat, self.lon]);
    if (points.length === 1) map.current?.setView(points[0]!, 14);
    else if (points.length > 1) map.current?.fitBounds(L.latLngBounds(points), { ...FIT_PADDING, maxZoom: 15 });
  };

  return (
    <div className="map-view">
      <div ref={box} className="map" />

      <div className="map-chips" role="group" aria-label="Show">
        {FILTERS.map((f) => (
          <button
            key={String(f.id)}
            type="button"
            className="map-chip"
            aria-pressed={filter === f.id}
            onClick={() => {
              setFilter(f.id);
              setGroup(null);
              if (picked && f.id !== "all" && picked.type !== f.id) setSelected(null);
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="map-controls">
        <IconButton label="Zoom in" onClick={() => map.current?.zoomIn()}>
          <PlusIcon size={18} />
        </IconButton>
        <IconButton label="Zoom out" onClick={() => map.current?.zoomOut()}>
          <MinusIcon size={18} />
        </IconButton>
        <IconButton label="Show all" onClick={fitAll}>
          <FitIcon size={18} />
        </IconButton>
        {self ? (
          <IconButton label="This radio" onClick={() => map.current?.setView([self.lat, self.lon], Math.max(map.current.getZoom(), 14))}>
            <LocateIcon size={18} />
          </IconButton>
        ) : null}
      </div>

      <div className="map-sheet">
        {picked ? (
          <NodeSheet contact={picked} contacts={contacts} self={self} />
        ) : group ? (
          <GroupSheet
            members={group}
            self={self}
            onPick={(key) => {
              setGroup(null);
              setSelected(key);
            }}
          />
        ) : (
          <>
            <div className="map-summary">
              <span>
                {shown.length} on the map
                {self ? "" : " · this radio has no position (Radio › Location)"}
              </span>
              {unplaced.length > 0 ? (
                <button type="button" className="link" onClick={() => setShowUnplaced((v) => !v)}>
                  {unplaced.length} without position
                </button>
              ) : null}
            </div>
            {showUnplaced ? (
              <p className="muted small">{unplaced.map((c) => c.name || c.prefix).join(", ")}</p>
            ) : placed.length === 0 ? (
              <p className="muted small">No contact has advertised a position yet. A node shares one when its owner sets it; the map fills as adverts arrive.</p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/** Nodes that share one spot, which no zoom separates: listed by name. */
function GroupSheet({ members, self, onPick }: { members: ContactRecord[]; self: Point | null; onPick: (key: string) => void }) {
  const rows = [...members].sort((a, b) => (a.name || a.prefix).localeCompare(b.name || b.prefix));
  return (
    <>
      <div className="map-summary">
        <span>{members.length} nodes here</span>
        {self ? <span>{formatDistance(distanceKm(self.lat, self.lon, rows[0]!.lat, rows[0]!.lon))} away</span> : null}
      </div>
      <div className="map-group-list">
        {rows.map((c) => (
          <button key={c.key} type="button" className="map-group-row" onClick={() => onPick(c.key)}>
            <Avatar name={c.name || c.prefix} type={c.type} size={24} />
            <span className="row-title">{c.name || c.prefix}</span>
            <span className="muted small">{contactTypeName(c.type)}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function NodeSheet({ contact, contacts, self }: { contact: ContactRecord; contacts: Record<string, ContactRecord>; self: Point | null }) {
  const name = contact.name || contact.prefix;
  const where = self ? distanceKm(self.lat, self.lon, contact.lat, contact.lon) : null;
  const heading = self ? compass(bearingDeg(self.lat, self.lon, contact.lat, contact.lon)) : null;
  const heard = contact.lastAdvert > 0 ? ago(contact.lastAdvert * 1000) : "never";
  const route = contactRoute(contact);
  const subtitle = [contactTypeName(contact.type), where !== null ? `${formatDistance(where)} ${heading}` : null, heard === "just now" || heard === "never" ? `advert ${heard}` : `advert ${heard} ago`]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <div className="map-node-head">
        <Avatar name={name} type={contact.type} size={32} />
        <div className="map-node-title">
          <span className="row-title">{name}</span>
          <span className="muted small">{subtitle}</span>
        </div>
      </div>
      <dl className="map-facts">
        <dt>Route</dt>
        <dd>
          {route === null ? (
            "none known, messages flood"
          ) : route.length === 0 ? (
            "direct, no relays"
          ) : (
            <span className="map-hops">
              {route.map((hash, i) => {
                const named = nameOfHash(hash, contacts);
                return (
                  <span key={`${hash}-${i}`} className={named ? "map-hop" : "map-hop unsure"} title={named ? hash : "More than one node, or none we know, has this hash"}>
                    {named ?? `${hash}?`}
                  </span>
                );
              })}
            </span>
          )}
        </dd>
        <dt>Position</dt>
        <dd className="mono">
          {contact.lat.toFixed(5)}, {contact.lon.toFixed(5)}
        </dd>
      </dl>
      <div className="row-actions">
        {isConversationType(contact.type) ? (
          <Button variant="primary" onClick={() => openConversation(contactConversation(contact.key))}>
            Message
          </Button>
        ) : null}
        <Button onClick={() => openContact(contact.key)}>Details</Button>
      </div>
    </>
  );
}
