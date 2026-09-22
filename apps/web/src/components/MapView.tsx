/**
 * The nodes on a map: every contact whose last advert carried a position, and
 * this radio. Tiles are OpenStreetMap's, kept on the device as they are seen
 * (lib/tiles.ts). Nodes that would overlap at the current zoom are gathered
 * into one circle with their count (lib/cluster.ts); tapping it zooms in on
 * them, or hands them up as a group when they share a spot. The picked node,
 * and the lines over the nodes (lib/mapOverlay.ts: a route coloured by a
 * ping, a line of sight), are the caller's: the map draws them and reports
 * taps, on a node, on a line, and a long press anywhere. Nothing here asks
 * the air for anything.
 */

import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { AdvType, type ContactRecord } from "@meshnet/meshcore";
import { clusterPoints, type Placed } from "../lib/cluster.js";
import { darkenPixels } from "../lib/darkTile.js";
import { ago, hue } from "../lib/format.js";
import { freshness, hasPosition } from "../lib/geo.js";
import { EMPTY_OVERLAY, type MapOverlay } from "../lib/mapOverlay.js";
import type { LosEnd } from "../lib/meshTool.js";
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

/** What a node's marker shows, as a string: a marker is redrawn only when this changes. `number` is its place in a route being changed. */
function nodeLook(contact: ContactRecord, nowSec: number, selected: boolean, number?: number): { look: string; make: () => L.DivIcon } {
  const age = contact.lastAdvert > 0 ? nowSec - contact.lastAdvert : Number.POSITIVE_INFINITY;
  const state = freshness(contact.type, age);
  const name = escapeHtml(contact.name || contact.prefix);
  const stale = state === "stale" && Number.isFinite(age) ? ` · ${ago(contact.lastAdvert * 1000)}` : "";
  const className = ["map-node", `t-${contact.type}`, state, selected ? "sel" : "", number ? "numbered" : ""].join(" ");
  const badge = number ? `<span class="map-num">${number}</span>` : "";
  const html = `<span class="map-pin" style="--hue:${hue(contact.name || contact.prefix)}">${glyph(contact)}</span>${badge}<span class="map-name">${name}${stale}</span>`;
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
  /** Pixels at the top under a phone's notch or status bar. */
  coverTop?: number | undefined;
  /** A phone zooms with two fingers; a desktop has buttons too. */
  zoomButtons?: boolean | undefined;
  /** Lines over the nodes, and numbers on the relays of a route being changed. */
  overlay?: MapOverlay | undefined;
  /** A line of the overlay tapped. */
  onLeg?: ((from: LosEnd, to: LosEnd) => void) | undefined;
  /** A long press, or a right click, on the map itself. */
  onHold?: ((lat: number, lon: number) => void) | undefined;
}

/** Where the map was left, so coming back to it, from a profile or another section, finds it there. */
let lastView: { center: L.LatLng; zoom: number } | null = null;

export default function MapView({ selected, onSelect, onGroup, filter, coverBottom = 0, coverTop = 0, zoomButtons = false, overlay = EMPTY_OVERLAY, onLeg, onHold }: MapProps) {
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
  const calls = useRef({ onSelect, onGroup, onLeg, onHold });
  calls.current = { onSelect, onGroup, onLeg, onHold };

  const contacts = state.contacts;
  const selfLat = state.self && hasPosition(state.self.lat, state.self.lon) ? state.self.lat : null;
  const selfLon = selfLat !== null ? state.self!.lon : null;
  const self = useMemo(() => (selfLat !== null && selfLon !== null ? { lat: selfLat, lon: selfLon } : null), [selfLat, selfLon]);
  const selfName = state.self?.name ?? "This radio";
  // Read when the map moves rather than when it renders: the sheet over it moves often and should not redraw it.
  const cover = useRef({ top: coverTop, bottom: coverBottom });
  cover.current = { top: coverTop, bottom: coverBottom };
  /** A fit keeps clear of the controls, the attribution, and what lies over the map. */
  const padding = (): L.FitBoundsOptions => ({ paddingTopLeft: [40, 56 + cover.current.top], paddingBottomRight: [64, 40 + cover.current.bottom] });
  /** A point in the middle of what is left uncovered, not of the whole map. */
  const centerOn = (at: L.LatLngExpression, zoom: number) => {
    const m = map.current;
    if (!m) return;
    const { top, bottom } = cover.current;
    m.setView(m.unproject(m.project(at, zoom).add([0, (bottom - top) / 2]), zoom), zoom);
  };

  const placed = useMemo(() => Object.values(contacts).filter((c) => hasPosition(c.lat, c.lon)).sort((a, b) => (a.key < b.key ? -1 : 1)), [contacts]);
  const shown = useMemo(() => placed.filter(filter), [placed, filter]);
  const picked = selected ? contacts[selected] ?? null : null;
  const numbers = overlay.numbers;

  // The map itself, once.
  useEffect(() => {
    if (!box.current) return;
    // A long press picks a spot; iOS needs Leaflet's own timer for it, Android and a mouse fire it themselves.
    const m = L.map(box.current, { zoomControl: false, attributionControl: false, worldCopyJump: true, minZoom: 2, maxZoom: 19, tapHold: true });
    L.control.attribution({ prefix: false, position: "topleft" }).addTo(m);
    const tiles = new CachedTileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(m);
    routeLayer.current = L.layerGroup().addTo(m);
    nodesLayer.current = L.layerGroup().addTo(m);
    if (lastView) {
      m.setView(lastView.center, lastView.zoom, { animate: false });
      fitted.current = true;
      setZoom(lastView.zoom);
    } else {
      m.setView([20, 0], 2);
    }
    // The finger lifting after a long press is not a tap on the map as well.
    let heldAt = 0;
    m.on("contextmenu", (e: L.LeafletMouseEvent) => {
      if (!calls.current.onHold) return;
      heldAt = Date.now();
      calls.current.onHold(e.latlng.lat, e.latlng.lng);
    });
    m.on("click", () => {
      if (Date.now() - heldAt < 500) return;
      calls.current.onSelect(null);
    });
    m.on("zoomend", () => setZoom(m.getZoom()));
    // Not while hidden under a profile: a map with no size has no middle to remember.
    m.on("moveend", () => {
      if (m.getSize().y > 0) lastView = { center: m.getCenter(), zoom: m.getZoom() };
    });
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
        wanted.set(c.key, { at: L.latLng(c.lat, c.lon), ...nodeLook(c, nowSec, c.key === selected, numbers[c.key]), members: g.members });
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
        else m.fitBounds(bounds, { ...padding(), maxZoom: m.getMaxZoom() });
      });
      entry.marker.addTo(layer);
      current.set(id, entry);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, selected, zoom, numbers]);

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

  // The lines over the nodes: a route and how it sounded, a line of sight, the answers to "who hears me".
  useEffect(() => {
    const layer = routeLayer.current;
    if (!layer) return;
    layer.clearLayers();
    for (const line of overlay.lines) {
      const points: L.LatLngTuple[] = [
        [line.from.lat, line.from.lon],
        [line.to.lat, line.to.lon],
      ];
      L.polyline(points, { className: "map-leg-under", interactive: false }).addTo(layer);
      L.polyline(points, { className: `map-leg ${line.tone}`, interactive: false }).addTo(layer);
      if (line.tappable) {
        // A wide line nobody sees, so a finger finds a thin one.
        L.polyline(points, { weight: 24, opacity: 0, bubblingMouseEvents: false })
          .on("click", () => calls.current.onLeg?.(line.from, line.to))
          .addTo(layer);
      }
      if (line.label) {
        const middle = L.latLng((line.from.lat + line.to.lat) / 2, (line.from.lon + line.to.lon) / 2);
        L.marker(middle, { interactive: false, keyboard: false, icon: L.divIcon({ className: "map-leg-label", html: escapeHtml(line.label), iconSize: [64, 18], iconAnchor: [32, 9] }) }).addTo(layer);
      }
    }
    for (const pin of overlay.pins) {
      L.marker([pin.lat, pin.lon], { interactive: false, keyboard: false, icon: L.divIcon({ className: "map-spot", html: "<span></span>", iconSize: [20, 20], iconAnchor: [10, 20] }) }).addTo(layer);
    }
  }, [overlay]);

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
      const { top, bottom } = cover.current;
      const clear = { left: 40, right: size.x - 64, top: top + 56, bottom: size.y - bottom - 40 };
      if (clear.right <= clear.left || clear.bottom <= clear.top) return;
      const p = m.latLngToContainerPoint(at);
      if (p.x > clear.left && p.x < clear.right && p.y > clear.top && p.y < clear.bottom) return;
      // In sight but under the sheet or at an edge: moved just clear. Out of sight: brought to the middle.
      if (p.x >= 0 && p.x <= size.x && p.y >= 0 && p.y <= size.y) {
        const dx = p.x < clear.left ? p.x - clear.left : p.x > clear.right ? p.x - clear.right : 0;
        const dy = p.y < clear.top ? p.y - clear.top : p.y > clear.bottom ? p.y - clear.bottom : 0;
        m.panBy([dx, dy]);
      } else {
        centerOn(at, Math.max(m.getZoom(), 13));
      }
    });
    return () => cancelAnimationFrame(frame);
    // Only a new pick moves the map; its neighbours changing, or the sheet moving, do not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedKey]);

  // The first time there is something to show, show all of it.
  useEffect(() => {
    const m = map.current;
    // A map with no size, hidden under a profile, has nothing to fit into.
    if (!m || fitted.current || m.getSize().y === 0) return;
    const points: L.LatLngTuple[] = placed.map((c) => [c.lat, c.lon]);
    if (self) points.push([self.lat, self.lon]);
    if (points.length === 1) centerOn(points[0]!, 13);
    else if (points.length > 1) m.fitBounds(L.latLngBounds(points), { ...padding(), maxZoom: 14 });
    if (points.length > 0) {
      fitted.current = true;
      setZoom(m.getZoom());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placed, self]);

  const fitAll = () => {
    const points: L.LatLngTuple[] = shown.map((c) => [c.lat, c.lon]);
    if (self) points.push([self.lat, self.lon]);
    if (points.length === 1) centerOn(points[0]!, 14);
    else if (points.length > 1) map.current?.fitBounds(L.latLngBounds(points), { ...padding(), maxZoom: 15 });
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
          <IconButton label="This radio" onClick={() => map.current && centerOn([self.lat, self.lon], Math.max(map.current.getZoom(), 14))}>
            <LocateIcon size={18} />
          </IconButton>
        ) : null}
      </div>
    </div>
  );
}
