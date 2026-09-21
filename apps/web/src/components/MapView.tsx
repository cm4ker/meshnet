/**
 * The nodes on a map: every contact whose last advert carried a position, and
 * this radio. Tiles are OpenStreetMap's, kept on the device as they are seen
 * (lib/tiles.ts). Picking a node shows how far and which way it is, and draws
 * the route the radio holds to it through the relays whose position is known.
 * Nothing here asks the air for anything.
 */

import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { AdvType, contactConversation, contactRoute, contactTypeName, isConversationType, type ContactRecord } from "@meshnet/meshcore";
import { candidatesOfHash, nameOfHash } from "../lib/echoes.js";
import { ago, hue } from "../lib/format.js";
import { bearingDeg, compass, distanceKm, formatDistance, freshness, hasPosition } from "../lib/geo.js";
import { openContact, openConversation } from "../lib/nav.js";
import { useSession } from "../lib/session.js";
import { TILE_ATTRIBUTION, TILE_URL, tileBlob } from "../lib/tiles.js";
import { Button, IconButton } from "../ui/Button.js";
import { Avatar } from "./Avatar.js";
import { FitIcon, LocateIcon, MinusIcon, PlusIcon } from "./Icons.js";

/** Serves each tile from the device's copy when it has one (lib/tiles.ts). */
class CachedTileLayer extends L.TileLayer {
  protected override createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
    const img = document.createElement("img");
    img.alt = "";
    img.setAttribute("role", "presentation");
    tileBlob(this.getTileUrl(coords))
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        img.onload = () => {
          URL.revokeObjectURL(url);
          done(undefined, img);
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          done(new Error("tile did not decode"), img);
        };
        img.src = url;
      })
      .catch((error: Error) => done(error, img));
    return img;
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

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function glyph(contact: ContactRecord): string {
  if (contact.type === AdvType.Repeater) return "";
  if (contact.type === AdvType.Room) return "#";
  if (contact.type === AdvType.Sensor) return "";
  return escapeHtml((contact.name || contact.prefix).slice(0, 1).toUpperCase());
}

function nodeIcon(contact: ContactRecord, nowSec: number, selected: boolean): L.DivIcon {
  const age = contact.lastAdvert > 0 ? nowSec - contact.lastAdvert : Number.POSITIVE_INFINITY;
  const state = freshness(contact.type, age);
  const name = escapeHtml(contact.name || contact.prefix);
  const stale = state === "stale" && Number.isFinite(age) ? ` · ${ago(contact.lastAdvert * 1000)}` : "";
  return L.divIcon({
    className: ["map-node", `t-${contact.type}`, state, selected ? "sel" : ""].join(" "),
    html: `<span class="map-pin" style="--hue:${hue(contact.name || contact.prefix)}">${glyph(contact)}</span><span class="map-name">${name}${stale}</span>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
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

export default function MapView() {
  const state = useSession();
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const nodesLayer = useRef<L.LayerGroup | null>(null);
  const fitted = useRef(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [showUnplaced, setShowUnplaced] = useState(false);

  const contacts = state.contacts;
  const self = state.self && hasPosition(state.self.lat, state.self.lon) ? { lat: state.self.lat, lon: state.self.lon } : null;
  const selfName = state.self?.name ?? "This radio";

  const { placed, unplaced } = useMemo(() => {
    const all = Object.values(contacts);
    return {
      placed: all.filter((c) => hasPosition(c.lat, c.lon)),
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
    new CachedTileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(m);
    nodesLayer.current = L.layerGroup().addTo(m);
    m.setView([20, 0], 2);
    m.on("click", () => setSelected(null));
    map.current = m;
    // The pane is sized by the layout, which changes when a phone turns or a desktop window is resized.
    const resize = new ResizeObserver(() => m.invalidateSize());
    resize.observe(box.current);
    return () => {
      resize.disconnect();
      m.remove();
      map.current = null;
      nodesLayer.current = null;
      fitted.current = false;
    };
  }, []);

  // The markers and the route, redrawn from the session.
  useEffect(() => {
    const m = map.current;
    const layer = nodesLayer.current;
    if (!m || !layer) return;
    layer.clearLayers();
    const nowSec = Date.now() / 1000;

    if (picked && hasPosition(picked.lat, picked.lon)) {
      const points = routePoints(picked, contacts, self);
      if (points) {
        L.polyline(
          points.map((p) => [p.lat, p.lon] as L.LatLngTuple),
          { className: "map-route", weight: 3, dashArray: "6 8", interactive: false },
        ).addTo(layer);
      }
    }
    for (const contact of shown) {
      L.marker([contact.lat, contact.lon], { icon: nodeIcon(contact, nowSec, contact.key === selected), keyboard: true, title: contact.name })
        .on("click", (e) => {
          L.DomEvent.stopPropagation(e);
          setSelected(contact.key);
        })
        .addTo(layer);
    }
    if (self) L.marker([self.lat, self.lon], { icon: selfIcon(selfName), interactive: false, zIndexOffset: 1000 }).addTo(layer);

    // The first time there is something to show, show all of it.
    if (!fitted.current) {
      const points: L.LatLngTuple[] = placed.map((c) => [c.lat, c.lon]);
      if (self) points.push([self.lat, self.lon]);
      if (points.length === 1) m.setView(points[0]!, 13);
      else if (points.length > 1) m.fitBounds(L.latLngBounds(points), { ...FIT_PADDING, maxZoom: 14 });
      if (points.length > 0) fitted.current = true;
    }
  }, [contacts, shown, placed, picked, selected, self?.lat, self?.lon, selfName]);

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
