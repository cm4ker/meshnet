/**
 * The nodes on a map: every contact whose last advert carried a position, and
 * this radio. Tiles are OpenStreetMap's, kept on the device as they are seen
 * (lib/tiles.ts). Nodes that would overlap at the current zoom are gathered
 * into one circle with their count (lib/cluster.ts); tapping it zooms in on
 * them, or hands them up as a group when they share a spot. The picked node,
 * and the lines over the nodes (lib/mapOverlay.ts: a route coloured by a
 * ping, a line of sight), are the caller's: the map draws them and reports
 * taps, on a node, on a line, and a long press anywhere, and a point of a
 * route dragged onto a node. Nothing here asks the air for anything.
 */

import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { AdvType, type ContactRecord } from "@meshnet/meshcore";
import { clusterPoints, type Group, type Placed } from "../lib/cluster.js";
import { darkenPixels } from "../lib/darkTile.js";
import { ago, hue } from "../lib/format.js";
import { freshness, hasPosition } from "../lib/geo.js";
import { EMPTY_OVERLAY, type MapHandle, type MapOverlay } from "../lib/mapOverlay.js";
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
function nodeLook(contact: ContactRecord, nowSec: number, selected: boolean, number?: number, hush = false): { look: string; make: () => L.DivIcon } {
  const age = contact.lastAdvert > 0 ? nowSec - contact.lastAdvert : Number.POSITIVE_INFINITY;
  const state = freshness(contact.type, age);
  const name = escapeHtml(contact.name || contact.prefix);
  const stale = state === "stale" && Number.isFinite(age) ? ` · ${ago(contact.lastAdvert * 1000)}` : "";
  const className = ["map-node", `t-${contact.type}`, state, selected ? "sel" : "", number ? "numbered" : "", hush ? "hush" : ""].join(" ");
  const badge = number ? `<span class="map-num">${number}</span>` : "";
  const html = `<span class="map-pin" style="--hue:${hue(contact.name || contact.prefix)}">${glyph(contact)}</span>${badge}<span class="map-name">${name}${stale}</span>`;
  return {
    look: className + html,
    make: () => L.divIcon({ className, html, iconSize: [22, 22], iconAnchor: [11, 11] }),
  };
}

type Box = { x0: number; y0: number; x1: number; y1: number };

/**
 * The nodes whose names would run over a group's circle, another pin or a name
 * already placed: those keep their pin and lose the name until a zoom makes room.
 * The picked node always keeps its own.
 */
function crowdedNames(groups: Group<ContactRecord>[], selected: string | null, self: L.Point | null): Set<string> {
  const around = (x: number, y: number, r: number): Box => ({ x0: x - r, y0: y - r, x1: x + r, y1: y + r });
  const taken: Box[] = groups.map((g) => around(g.x, g.y, g.members.length === 1 ? 11 : g.members.length < 10 ? 16 : 22));
  if (self) taken.push(around(self.x, self.y, 11));
  const hits = (b: Box) => taken.some((t) => b.x0 < t.x1 && b.x1 > t.x0 && b.y0 < t.y1 && b.y1 > t.y0);
  const singles = groups.filter((g) => g.members.length === 1);
  // The pick first, so it is the one others give way to.
  singles.sort((a, b) => Number(b.members[0]!.key === selected) - Number(a.members[0]!.key === selected));
  const hushed = new Set<string>();
  for (const g of singles) {
    const c = g.members[0]!;
    // Where .map-name draws: 15 px right of the pin's centre, 16 px tall, about 6 px a letter.
    const name = { x0: g.x + 15, y0: g.y - 8, x1: g.x + 15 + (c.name || c.prefix).length * 6.2, y1: g.y + 8 };
    if (c.key !== selected && hits(name)) hushed.add(c.key);
    else taken.push(name);
  }
  return hushed;
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
  /** A point of a route dragged onto a node: its key, or "self" for this radio. */
  onHandleDrop?: ((handle: MapHandle, onto: string) => void) | undefined;
}

/** How near a node, in pixels, a dragged point lets go onto it. */
const SNAP_PX = 36;

/** Where the map was left, so coming back to it, from a profile or another section, finds it there. */
let lastView: { center: L.LatLng; zoom: number } | null = null;

export default function MapView({ selected, onSelect, onGroup, filter, coverBottom = 0, coverTop = 0, zoomButtons = false, overlay = EMPTY_OVERLAY, onLeg, onHold, onHandleDrop }: MapProps) {
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
  const calls = useRef({ onSelect, onGroup, onLeg, onHold, onHandleDrop });
  calls.current = { onSelect, onGroup, onLeg, onHold, onHandleDrop };

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
  // What a dragged point can let go onto, read while it is dragged: every node on the map, and this radio.
  const targets = useRef<{ key: string; at: L.LatLng }[]>([]);
  targets.current = [...placed.map((c) => ({ key: c.key, at: L.latLng(c.lat, c.lon) })), ...(self ? [{ key: "self", at: L.latLng(self.lat, self.lon) }] : [])];

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
    const groups = clusterPoints(points, CLUSTER_RADIUS);
    const hushed = crowdedNames(groups, selected, self ? m.project([self.lat, self.lon], z) : null);
    for (const g of groups) {
      if (g.members.length === 1) {
        const c = g.members[0]!;
        wanted.set(c.key, { at: L.latLng(c.lat, c.lon), ...nodeLook(c, nowSec, c.key === selected, numbers[c.key], hushed.has(c.key)), members: g.members });
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
  }, [shown, selected, zoom, numbers, self]);

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
      // Thin lines drawn beside a route go without its halo.
      if (line.tone !== "back" && line.tone !== "was") L.polyline(points, { className: "map-leg-under", interactive: false }).addTo(layer);
      L.polyline(points, { className: `map-leg ${line.tone}`, interactive: false }).addTo(layer);
      if (line.tappable) {
        // A wide line nobody sees, so a finger finds a thin one.
        L.polyline(points, { weight: 24, opacity: 0, bubblingMouseEvents: false })
          .on("click", () => calls.current.onLeg?.(line.from, line.to))
          .addTo(layer);
      }
      if (line.label) {
        const middle = L.latLng((line.from.lat + line.to.lat) / 2, (line.from.lon + line.to.lon) / 2);
        // Above the leg's middle, clear of the point that drags it.
        L.marker(middle, { interactive: false, keyboard: false, icon: L.divIcon({ className: "map-leg-label", html: escapeHtml(line.label), iconSize: [64, 18], iconAnchor: [32, 30] }) }).addTo(layer);
      }
    }
    for (const pin of overlay.pins) {
      L.marker([pin.lat, pin.lon], { interactive: false, keyboard: false, icon: L.divIcon({ className: "map-spot", html: "<span></span>", iconSize: [20, 20], iconAnchor: [10, 20] }) }).addTo(layer);
    }
    for (const handle of overlay.handles) dragHandle(layer, handle, handle.key ? overlay.numbers[handle.key] : undefined);
    if (overlay.pulse) {
      // A flood going out: rings spreading from this radio, under the nodes.
      L.marker([overlay.pulse.lat, overlay.pulse.lon], { interactive: false, keyboard: false, zIndexOffset: -1000, icon: L.divIcon({ className: "map-flood", html: "<i></i><i></i><i></i>", iconSize: [260, 260], iconAnchor: [130, 130] }) }).addTo(layer);
    }
  }, [overlay]);

  /** The node nearest to a point, within reach of a finger letting go. */
  const snapAt = (at: L.LatLng): { key: string; at: L.LatLng } | null => {
    const m = map.current;
    if (!m) return null;
    const p = m.latLngToContainerPoint(at);
    let best: { key: string; at: L.LatLng } | null = null;
    let reach = SNAP_PX;
    for (const t of targets.current) {
      const d = p.distanceTo(m.latLngToContainerPoint(t.at));
      if (d < reach) {
        best = t;
        reach = d;
      }
    }
    // Nodes gathered into a circle are let go onto through it: a repeater among them, the nearest first.
    for (const entry of markers.current.values()) {
      if (entry.members.length < 2) continue;
      const at = entry.marker.getLatLng();
      const d = p.distanceTo(m.latLngToContainerPoint(at));
      if (d >= reach) continue;
      const near = (c: ContactRecord) => p.distanceTo(m.latLngToContainerPoint([c.lat, c.lon]));
      const member = [...entry.members].sort((a, b) => Number(b.type === AdvType.Repeater) - Number(a.type === AdvType.Repeater) || near(a) - near(b))[0]!;
      best = { key: member.key, at };
      reach = d;
    }
    return best;
  };

  /**
   * A point of a route that follows the finger: the legs either side stretch
   * to it, and a ring marks the node it would let go onto. Let go, it goes
   * back to its place and says where it was dropped; the caller redraws the
   * route. A tap on a relay picks it, a tap on a leg's middle opens the leg.
   */
  function dragHandle(layer: L.LayerGroup, handle: MapHandle, number: number | undefined): void {
    const size = handle.kind === "hop" ? 34 : 26;
    // A relay's place in a route being changed rides on its ring, which covers the marker's own.
    const badge = number ? `<b class="map-num">${number}</b>` : "";
    const home = L.latLng(handle.lat, handle.lon);
    const marker = L.marker(home, {
      draggable: true,
      autoPan: true,
      keyboard: false,
      zIndexOffset: handle.kind === "hop" ? 1500 : 1400,
      icon: L.divIcon({ className: `map-handle map-handle-${handle.kind}`, html: `<span></span>${badge}`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
    });
    let rubber: L.Polyline | null = null;
    let ring: L.Marker | null = null;
    const stretch = (tip: L.LatLng) => {
      const points: L.LatLng[] = [];
      if (handle.from) points.push(L.latLng(handle.from.lat, handle.from.lon));
      points.push(tip);
      if (handle.to) points.push(L.latLng(handle.to.lat, handle.to.lon));
      rubber?.setLatLngs(points);
    };
    marker.on("dragstart", () => {
      marker.getElement()?.classList.add("dragging");
      rubber = L.polyline([], { className: "map-leg rubber", interactive: false }).addTo(layer);
      ring = L.marker(home, { interactive: false, keyboard: false, opacity: 0, icon: L.divIcon({ className: "map-snap", html: "<span></span>", iconSize: [40, 40], iconAnchor: [20, 20] }) }).addTo(layer);
      stretch(home);
    });
    marker.on("drag", () => {
      const snap = snapAt(marker.getLatLng());
      stretch(snap?.at ?? marker.getLatLng());
      if (snap) ring?.setLatLng(snap.at);
      ring?.setOpacity(snap ? 1 : 0);
    });
    marker.on("dragend", () => {
      const snap = snapAt(marker.getLatLng());
      rubber?.remove();
      ring?.remove();
      marker.getElement()?.classList.remove("dragging");
      marker.setLatLng(home);
      if (snap) calls.current.onHandleDrop?.(handle, snap.key);
    });
    marker.on("click", (e) => {
      L.DomEvent.stopPropagation(e);
      if (handle.kind === "hop" && handle.key) calls.current.onSelect(handle.key);
      else if (handle.kind === "gap" && handle.from && handle.to) calls.current.onLeg?.(handle.from, handle.to);
    });
    marker.addTo(layer);
  }

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
