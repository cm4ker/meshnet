/**
 * The nodes on a map: every contact whose last advert carried a position, and
 * this radio. Tiles are OpenStreetMap's, kept on the device as they are seen
 * (lib/tiles.ts). Nodes that would overlap at the current zoom are gathered
 * into one circle with their count (lib/cluster.ts); tapping it zooms in on
 * them, or hands them up as a group when they share a spot. The picked node
 * and its route are the caller's: the map draws them and reports taps.
 * Nothing here asks the air for anything.
 */

import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { AdvType, contactRoute, type ContactRecord } from "@meshnet/meshcore";
import { clusterPoints, type Placed } from "../lib/cluster.js";
import { darkenPixels } from "../lib/darkTile.js";
import { candidatesOfHash } from "../lib/echoes.js";
import { ago, hue } from "../lib/format.js";
import { freshness, hasPosition } from "../lib/geo.js";
import { useSession } from "../lib/session.js";
import { TILE_ATTRIBUTION, TILE_URL, tileBlob } from "../lib/tiles.js";
import { IconButton } from "../ui/Button.js";
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

interface Point {
  lat: number;
  lon: number;
}


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


export interface MapProps {
  /** The node picked, drawn ringed with its route. */
  selected: string | null;
  onSelect: (key: string | null) => void;
  /** Nodes that share a spot no zoom separates. */
  onGroup: (keys: string[]) => void;
  /** Which nodes to show. */
  filter: (contact: ContactRecord) => boolean;
  /** Pixels at the bottom covered by a sheet, so nothing is fitted under it. */
  coverBottom?: number | undefined;
  /** A phone zooms with two fingers; a desktop has buttons too. */
  zoomButtons?: boolean | undefined;
}

export default function MapView({ selected, onSelect, onGroup, filter, coverBottom = 0, zoomButtons = false }: MapProps) {
  const state = useSession();
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const nodesLayer = useRef<L.LayerGroup | null>(null);
  const routeLayer = useRef<L.LayerGroup | null>(null);
  const selfMarker = useRef<L.Marker | null>(null);
  const markers = useRef(new Map<string, Shown>());
  const fitted = useRef(false);
  const [zoom, setZoom] = useState(2);
  // The handlers Leaflet holds are set once; they read the latest callbacks from here.
  const calls = useRef({ onSelect, onGroup });
  calls.current = { onSelect, onGroup };

  const contacts = state.contacts;
  const selfLat = state.self && hasPosition(state.self.lat, state.self.lon) ? state.self.lat : null;
  const selfLon = selfLat !== null ? state.self!.lon : null;
  const self = useMemo(() => (selfLat !== null && selfLon !== null ? { lat: selfLat, lon: selfLon } : null), [selfLat, selfLon]);
  const selfName = state.self?.name ?? "This radio";
  const padding = useMemo<L.FitBoundsOptions>(() => ({ paddingTopLeft: [40, 56], paddingBottomRight: [64, 40 + coverBottom] }), [coverBottom]);

  const placed = useMemo(() => Object.values(contacts).filter((c) => hasPosition(c.lat, c.lon)).sort((a, b) => (a.key < b.key ? -1 : 1)), [contacts]);
  const shown = useMemo(() => placed.filter(filter), [placed, filter]);
  const picked = selected ? contacts[selected] ?? null : null;

  // The map itself, once.
  useEffect(() => {
    if (!box.current) return;
    const m = L.map(box.current, { zoomControl: false, attributionControl: false, worldCopyJump: true, minZoom: 2, maxZoom: 19 });
    L.control.attribution({ prefix: false, position: "topleft" }).addTo(m);
    const tiles = new CachedTileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(m);
    routeLayer.current = L.layerGroup().addTo(m);
    nodesLayer.current = L.layerGroup().addTo(m);
    m.setView([20, 0], 2);
    m.on("click", () => calls.current.onSelect(null));
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
          calls.current.onSelect(entry.members[0]!.key);
          return;
        }
        const bounds = L.latLngBounds(entry.members.map((c) => [c.lat, c.lon] as L.LatLngTuple));
        const spread = bounds.getNorthEast().distanceTo(bounds.getSouthWest());
        if (spread < SAME_SPOT_M || m.getZoom() >= m.getMaxZoom()) calls.current.onGroup(entry.members.map((c) => c.key));
        else m.fitBounds(bounds, { ...padding, maxZoom: m.getMaxZoom() });
      });
      entry.marker.addTo(layer);
      current.set(id, entry);
    }
  }, [shown, selected, zoom, padding]);

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

  // A node picked from outside the map, from its profile or the list, is brought into view.
  const pickedKey = picked && hasPosition(picked.lat, picked.lon) ? picked.key : null;
  useEffect(() => {
    const m = map.current;
    const c = pickedKey ? contacts[pickedKey] : undefined;
    if (!m || !c) return;
    // After the layout settles: a desktop's panel opens beside the map in the same render.
    const frame = requestAnimationFrame(() => {
      m.invalidateSize();
      const at = L.latLng(c.lat, c.lon);
      const size = m.getSize();
      const point = m.latLngToContainerPoint(at);
      const inside = point.x > 40 && point.x < size.x - 64 && point.y > 56 && point.y < size.y - 40 - coverBottom;
      if (!inside) m.setView(at, Math.max(m.getZoom(), 13));
    });
    return () => cancelAnimationFrame(frame);
    // Only a new pick moves the map; its neighbours changing, or the sheet moving, do not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedKey]);

  // The first time there is something to show, show all of it.
  useEffect(() => {
    const m = map.current;
    if (!m || fitted.current) return;
    const points: L.LatLngTuple[] = placed.map((c) => [c.lat, c.lon]);
    if (self) points.push([self.lat, self.lon]);
    if (points.length === 1) m.setView(points[0]!, 13);
    else if (points.length > 1) m.fitBounds(L.latLngBounds(points), { ...padding, maxZoom: 14 });
    if (points.length > 0) {
      fitted.current = true;
      setZoom(m.getZoom());
    }
  }, [placed, self, padding]);

  const fitAll = () => {
    const points: L.LatLngTuple[] = shown.map((c) => [c.lat, c.lon]);
    if (self) points.push([self.lat, self.lon]);
    if (points.length === 1) map.current?.setView(points[0]!, 14);
    else if (points.length > 1) map.current?.fitBounds(L.latLngBounds(points), { ...padding, maxZoom: 15 });
  };

  return (
    <div className="map-view">
      <div ref={box} className="map" />
      <div className="map-controls">
        {zoomButtons ? (
          <>
            <IconButton label="Zoom in" onClick={() => map.current?.zoomIn()}>
              <PlusIcon size={18} />
            </IconButton>
            <IconButton label="Zoom out" onClick={() => map.current?.zoomOut()}>
              <MinusIcon size={18} />
            </IconButton>
          </>
        ) : null}
        <IconButton label="Show all" onClick={fitAll}>
          <FitIcon size={18} />
        </IconButton>
        {self ? (
          <IconButton label="This radio" onClick={() => map.current?.setView([self.lat, self.lon], Math.max(map.current.getZoom(), 14))}>
            <LocateIcon size={18} />
          </IconButton>
        ) : null}
      </div>
    </div>
  );
}
