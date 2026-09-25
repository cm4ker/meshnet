/**
 * The nodes of the map drawn on one canvas rather than a DOM marker each.
 *
 * A marker is an element with its own 3D transform, so a few hundred of them
 * are a few hundred compositor layers: every frame of a pan or a pinch moves
 * them all, and every zoom step writes all their positions. The canvas is one
 * element. It rides the map pane while panning and is scaled whole during a
 * zoom, as Leaflet's own vector renderer is; it is painted again only when a
 * move ends, a node changes, or the minute turns. It reaches a third of a
 * screen past the view on every side, and a longer drag paints it again
 * round where the view has got to, so a pan shows drawn nodes, not a gap.
 *
 * It takes no pointer events: the map hands taps and hovers to `hit()`.
 * Nodes too close to tell apart are gathered by lib/cluster.ts when grouping
 * is on, once per zoom; with it off every node is drawn, and names that would
 * run over a pin or another name are left out until a zoom makes room.
 */

import * as L from "leaflet";
import { AdvType, type ContactRecord } from "@meshnet/meshcore";
import { t } from "../i18n/index.js";
import { clusterPoints } from "./cluster.js";
import { ago, hue, trailingEmoji } from "./format.js";
import { freshness } from "./geo.js";

/** How close, in screen pixels, two markers may come before they are gathered: a marker and its name. */
const CLUSTER_RADIUS = 44;
/** A pin's half size. */
const PIN = 11;
/** Room on the canvas past the view, as a share of it on each side. */
const PADDING = 0.3;
/** The most device pixels the canvas takes: about 24 MB of memory. */
const MAX_PIXELS = 6_000_000;

export interface NodeGroup {
  members: ContactRecord[];
  at: L.LatLng;
}

export interface NodeData {
  nodes: ContactRecord[];
  selected: string | null;
  /** Places in a route being changed, by key. */
  numbers: Record<string, number>;
  grouping: boolean;
  self: L.LatLng | null;
}

interface Placed {
  group: NodeGroup;
  /** Pixels at the zoom it was grouped for. */
  px: number;
  py: number;
}

interface Drawn {
  group: NodeGroup;
  /** Layer pixels. */
  x: number;
  y: number;
  r: number;
}

type Box = { x0: number; y0: number; x1: number; y1: number };

interface Palette {
  bg: string;
  text: string;
  muted: string;
  faint: string;
  accent: string;
  accentInk: string;
  groupFill: string;
  groupGlow: string;
  font: string;
}

function css(style: CSSStyleDeclaration, name: string, fallback: string): string {
  return style.getPropertyValue(name).trim() || fallback;
}

function rgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `a` over `b` at `share`, as color-mix does for the DOM markers; `a` alone when either is not a hex colour. */
function mix(a: string, b: string, share: number, alpha = 1): string {
  const x = rgb(a);
  const y = rgb(b) ?? x;
  if (!x || !y) return a;
  const c = x.map((v, i) => Math.round(v * share + y[i]! * (1 - share)));
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}

function palette(): Palette {
  const style = getComputedStyle(document.documentElement);
  const bg = css(style, "--bg", "#fafafa");
  const accent = css(style, "--accent", "#5c78e2");
  return {
    bg,
    text: css(style, "--text", "#242529"),
    muted: css(style, "--text-muted", "#5c5e63"),
    faint: css(style, "--text-faint", "#8a8c91"),
    accent,
    accentInk: css(style, "--accent-contrast", "#fafafa"),
    groupFill: mix(accent, bg, 0.88),
    groupGlow: mix(accent, accent, 1, 0.28),
    font: css(style, "--font-ui", "system-ui, sans-serif"),
  };
}

/** oklch to sRGB, as the avatars' `oklch(62% 0.11 hue)`: a canvas in an older WebView may not take oklch itself. */
function oklch(l: number, c: number, h: number): string {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  const out = lin.map((v) => {
    const x = Math.min(1, Math.max(0, v));
    return Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
  });
  return `rgb(${out[0]},${out[1]},${out[2]})`;
}

const swatches = new Map<number, { fill: string; ink: string }>();
function swatch(name: string): { fill: string; ink: string } {
  const h = hue(name);
  let s = swatches.get(h);
  if (!s) {
    s = { fill: oklch(0.62, 0.11, h), ink: oklch(0.2, 0.03, h) };
    swatches.set(h, s);
  }
  return s;
}

const glyphs = new Map<string, { text: string; emoji: boolean }>();
/** What a node's pin carries: the emoji its name ends with, else its first letter; a repeater or sensor, nothing. */
function glyph(c: ContactRecord): { text: string; emoji: boolean } {
  if (c.type === AdvType.Repeater || c.type === AdvType.Sensor) return { text: "", emoji: false };
  if (c.type === AdvType.Room) return { text: "#", emoji: false };
  const name = c.name || c.prefix;
  let g = glyphs.get(name);
  if (!g) {
    const emoji = trailingEmoji(name);
    g = emoji ? { text: emoji, emoji: true } : { text: name.slice(0, 1).toUpperCase(), emoji: false };
    glyphs.set(name, g);
  }
  return g;
}

/** By arcs: `ctx.roundRect` is missing from the WebView of an iPhone before iOS 16. */
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** The outline of a node's pin, grown by `grow`: a person a circle, a repeater a mast's diamond, a room a square, a sensor a hexagon. */
function shape(ctx: CanvasRenderingContext2D, type: number, x: number, y: number, grow: number): void {
  if (type === AdvType.Repeater) {
    const r = 9 * Math.SQRT2 + grow;
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
  } else if (type === AdvType.Room) {
    roundRect(ctx, x - PIN - grow, y - PIN - grow, 2 * (PIN + grow), 2 * (PIN + grow), 6 + grow);
  } else if (type === AdvType.Sensor) {
    const r = PIN + grow;
    const w = r * 0.86;
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + w, y - r / 2);
    ctx.lineTo(x + w, y + r / 2);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - w, y + r / 2);
    ctx.lineTo(x - w, y - r / 2);
    ctx.closePath();
  } else {
    ctx.beginPath();
    ctx.arc(x, y, PIN + grow, 0, 2 * Math.PI);
  }
}

/** A grid of boxes, so asking what a name would run over costs the boxes near it, not all of them. */
class Boxes {
  private cells = new Map<number, Box[]>();
  private static readonly CELL = 64;
  private *keys(b: Box): Generator<number> {
    const c = Boxes.CELL;
    for (let cx = Math.floor(b.x0 / c); cx <= Math.floor(b.x1 / c); cx++) {
      for (let cy = Math.floor(b.y0 / c); cy <= Math.floor(b.y1 / c); cy++) yield cx * 131072 + cy;
    }
  }
  add(b: Box): void {
    for (const k of this.keys(b)) {
      const list = this.cells.get(k);
      if (list) list.push(b);
      else this.cells.set(k, [b]);
    }
  }
  hits(b: Box): boolean {
    for (const k of this.keys(b)) {
      for (const t of this.cells.get(k) ?? []) if (b.x0 < t.x1 && b.x1 > t.x0 && b.y0 < t.y1 && b.y1 > t.y0) return true;
    }
    return false;
  }
}

function groupSize(n: number): number {
  return n < 10 ? 32 : n < 100 ? 38 : 44;
}

export class NodeCanvas extends L.Renderer {
  private data: NodeData = { nodes: [], selected: null, numbers: {}, grouping: true, self: null };
  private placed: Placed[] = [];
  private placedZoom: number | null = null;
  private drawn: Drawn[] = [];
  private widths = new Map<string, number>();
  private widthFont = "";

  constructor(options?: L.RendererOptions) {
    super({ padding: PADDING, ...options });
  }

  /** New nodes, a new pick, grouping turned on or off: grouped again and painted. */
  setData(data: NodeData): void {
    const regroup = data.nodes !== this.data.nodes || data.grouping !== this.data.grouping;
    this.data = data;
    if (regroup) this.placedZoom = null;
    this.paint();
  }

  /** Painted again as it is: the times beside the names, a new theme, a font that arrived. */
  redraw(): this {
    this.widths.clear();
    this.paint();
    return this;
  }

  /** The groups on the map now, a single node being a group of one, where they are drawn. */
  groups(): NodeGroup[] {
    return this.drawn.map((d) => d.group);
  }

  /**
   * What is under a point of the layer: the nodes of the topmost circle, or of
   * the pins within `slop` of it. Pins stacked on one spot come back together;
   * otherwise the nearest one alone.
   */
  hit(point: L.Point, slop: number): ContactRecord[] | null {
    let best: Drawn | null = null;
    let bestD = Infinity;
    const singles: { d: Drawn; dist: number }[] = [];
    for (const d of this.drawn) {
      const dist = Math.hypot(d.x - point.x, d.y - point.y);
      if (dist > d.r + slop) continue;
      if (d.group.members.length === 1) singles.push({ d, dist });
      if (dist < bestD) {
        best = d;
        bestD = dist;
      }
    }
    if (!best) return null;
    if (best.group.members.length > 1) return best.group.members;
    const stacked = singles.filter((s) => Math.hypot(s.d.x - best.x, s.d.y - best.y) < 4);
    return stacked.length > 1 ? stacked.map((s) => s.d.group.members[0]!) : best.group.members;
  }

  // ---- Leaflet's renderer contract ----

  _initContainer(): void {
    const canvas = document.createElement("canvas");
    canvas.style.pointerEvents = "none";
    const self = this as unknown as { _container: HTMLCanvasElement; _ctx: CanvasRenderingContext2D | null };
    self._container = canvas;
    self._ctx = canvas.getContext("2d");
  }

  _destroyContainer(): void {
    const self = this as unknown as { _container?: HTMLCanvasElement; _ctx?: CanvasRenderingContext2D | null };
    cancelAnimationFrame(this.moveFrame);
    this.moveFrame = 0;
    self._container?.remove();
    delete self._container;
    delete self._ctx;
  }

  getEvents(): { [name: string]: L.LeafletEventHandlerFn } {
    return { ...super.getEvents?.(), move: this.onMove };
  }

  /**
   * A long drag that has carried the view past the painted edge: painted again
   * round where it is, at most once a frame, so nodes do not wait for the
   * finger to lift. A zoom scales the canvas instead and is left alone.
   */
  private moveFrame = 0;
  private onMove = (): void => {
    const self = this as unknown as { _map?: L.Map & { _animatingZoom?: boolean }; _bounds?: L.Bounds };
    const map = self._map;
    const b = self._bounds;
    if (!map || !b?.min || !b.max || map._animatingZoom || this.moveFrame) return;
    const topLeft = map.containerPointToLayerPoint([0, 0]);
    const bottomRight = map.containerPointToLayerPoint(map.getSize());
    if (topLeft.x >= b.min.x && topLeft.y >= b.min.y && bottomRight.x <= b.max.x && bottomRight.y <= b.max.y) return;
    this.moveFrame = requestAnimationFrame(() => {
      this.moveFrame = 0;
      if ((this as unknown as { _map?: L.Map })._map) this._update();
    });
  };

  _update(): void {
    const self = this as unknown as { _map: L.Map & { _animatingZoom?: boolean }; _bounds?: L.Bounds; _container: HTMLCanvasElement };
    if (self._map._animatingZoom && self._bounds) return;
    (L.Renderer.prototype as unknown as { _update: () => void })._update.call(this);
    const b = self._bounds!;
    const size = b.getSize();
    // Sharp on the screen's pixels, but never past MAX_PIXELS: a phone's WebView refuses, or runs out
    // of memory for, a canvas much larger than that.
    const ratio = Math.min(window.devicePixelRatio || 1, 3, Math.sqrt(MAX_PIXELS / Math.max(1, size.x * size.y)));
    const canvas = self._container;
    L.DomUtil.setPosition(canvas, b.min!);
    canvas.width = Math.round(size.x * ratio);
    canvas.height = Math.round(size.y * ratio);
    canvas.style.width = `${size.x}px`;
    canvas.style.height = `${size.y}px`;
    this.paint();
  }

  // ---- painting ----

  private regroup(map: L.Map, zoom: number): void {
    const { nodes, grouping } = this.data;
    const points = nodes.map((c) => {
      const p = map.project([c.lat, c.lon], zoom);
      return { item: c, x: p.x, y: p.y };
    });
    if (!grouping) {
      this.placed = points.map((p) => ({ group: { members: [p.item], at: L.latLng(p.item.lat, p.item.lon) }, px: p.x, py: p.y }));
    } else {
      this.placed = clusterPoints(points, CLUSTER_RADIUS).map((g) => ({
        group: { members: g.members, at: g.members.length === 1 ? L.latLng(g.members[0]!.lat, g.members[0]!.lon) : map.unproject([g.x, g.y], zoom) },
        px: g.x,
        py: g.y,
      }));
    }
    this.placedZoom = zoom;
  }

  private width(ctx: CanvasRenderingContext2D, text: string): number {
    if (ctx.font !== this.widthFont) {
      this.widths.clear();
      this.widthFont = ctx.font;
    }
    let w = this.widths.get(text);
    if (w === undefined) {
      w = ctx.measureText(text).width;
      this.widths.set(text, w);
    }
    return w;
  }

  private paint(): void {
    const self = this as unknown as { _map?: L.Map; _bounds?: L.Bounds; _ctx?: CanvasRenderingContext2D | null; _container?: HTMLCanvasElement };
    const map = self._map;
    const ctx = self._ctx;
    const bounds = self._bounds;
    const canvas = self._container;
    if (!map || !ctx || !bounds?.min || !bounds.max || !canvas) return;
    const { min, max } = bounds;
    const zoom = map.getZoom();
    if (this.placedZoom !== zoom) this.regroup(map, zoom);

    const ratio = canvas.width / Math.max(1, max.x - min.x);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(ratio, 0, 0, ratio, -min.x * ratio, -min.y * ratio);

    const origin = map.getPixelOrigin();
    const { selected, numbers, self: me } = this.data;
    const pal = palette();
    const nowSec = Date.now() / 1000;
    const nameFont = `500 11px ${pal.font}`;
    // Read once a paint, in the language of the moment: a change of language paints anew, and no label outlives it.
    const justNow = t("common.justNow");
    const now = t("mesh.map.now");

    // Only what falls on the canvas, with room for a name reaching in from the left.
    const x0 = min.x - 240;
    const x1 = max.x + 30;
    const y0 = min.y - 30;
    const y1 = max.y + 30;
    const drawn: Drawn[] = [];
    for (const p of this.placed) {
      const x = p.px - origin.x;
      const y = p.py - origin.y;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      const n = p.group.members.length;
      drawn.push({ group: p.group, x, y, r: n === 1 ? PIN : groupSize(n) / 2 });
    }
    // South over north, as markers stack; the pick on top of everything.
    const holdsPick = (d: Drawn) => selected !== null && d.group.members.some((c) => c.key === selected);
    drawn.sort((a, b) => Number(holdsPick(a)) - Number(holdsPick(b)) || a.y - b.y);
    this.drawn = drawn;

    // Which names fit: the pick's first, then a route's numbered relays, then the most recently heard.
    ctx.font = nameFont;
    const taken = new Boxes();
    for (const d of drawn) taken.add({ x0: d.x - d.r, y0: d.y - d.r, x1: d.x + d.r, y1: d.y + d.r });
    if (me) {
      const p = map.project(me, zoom);
      const x = p.x - origin.x;
      const y = p.y - origin.y;
      taken.add({ x0: x - PIN, y0: y - PIN, x1: x + PIN, y1: y + PIN });
    }
    const labels: { d: Drawn; c: ContactRecord; name: string; when: string; state: string; left: number }[] = [];
    const singles = drawn.filter((d) => d.group.members.length === 1);
    const rank = (c: ContactRecord) => (c.key === selected ? 2 : numbers[c.key] ? 1 : 0);
    singles.sort((a, b) => {
      const ca = a.group.members[0]!;
      const cb = b.group.members[0]!;
      return rank(cb) - rank(ca) || cb.lastAdvert - ca.lastAdvert;
    });
    for (const d of singles) {
      const c = d.group.members[0]!;
      const age = c.lastAdvert > 0 ? nowSec - c.lastAdvert : Infinity;
      const state = freshness(c.type, age);
      const name = c.name || c.prefix;
      const heard = Number.isFinite(age) ? ago(c.lastAdvert * 1000) : "";
      const when = heard ? ` · ${heard === justNow ? now : heard}` : "";
      const left = d.x + (numbers[c.key] ? 19 : 15);
      const box = { x0: left, y0: d.y - 8, x1: left + this.width(ctx, name) + this.width(ctx, when), y1: d.y + 8 };
      if (c.key !== selected && taken.hits(box)) continue;
      taken.add(box);
      labels.push({ d, c, name, when, state, left });
    }

    for (const d of drawn) {
      if (d.group.members.length === 1) this.pin(ctx, pal, d, nowSec);
      else this.circle(ctx, pal, d, holdsPick(d));
    }

    ctx.font = nameFont;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = pal.bg;
    for (const l of labels) {
      const y = l.d.y + 0.5;
      const w = this.width(ctx, l.name);
      ctx.strokeText(l.name, l.left, y);
      ctx.fillStyle = l.state === "stale" ? pal.muted : pal.text;
      ctx.fillText(l.name, l.left, y);
      if (l.when) {
        ctx.strokeText(l.when, l.left + w, y);
        ctx.fillStyle = pal.faint;
        ctx.fillText(l.when, l.left + w, y);
      }
    }
  }

  private pin(ctx: CanvasRenderingContext2D, pal: Palette, d: Drawn, nowSec: number): void {
    const c = d.group.members[0]!;
    const { x, y } = d;
    const age = c.lastAdvert > 0 ? nowSec - c.lastAdvert : Infinity;
    const state = freshness(c.type, age);
    const stale = state === "stale";
    const selected = c.key === this.data.selected;
    const repeater = c.type === AdvType.Repeater;
    const { fill, ink } = swatch(c.name || c.prefix);
    const body = repeater ? pal.text : fill;

    if (selected) {
      ctx.beginPath();
      ctx.arc(x, y, PIN + (repeater ? 5 : 4), 0, 2 * Math.PI);
      ctx.lineWidth = 2;
      ctx.strokeStyle = pal.accent;
      ctx.stroke();
    }
    ctx.globalAlpha = state === "aging" ? 0.6 : 1;
    // The drop shadow the DOM pin had, as a darker copy one pixel down.
    shape(ctx, c.type, x, y + 1, 0.5);
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fill();
    shape(ctx, c.type, x, y, 0);
    if (c.type === AdvType.Sensor) {
      ctx.fillStyle = stale ? pal.bg : body;
      ctx.fill();
      if (stale) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = body;
        ctx.stroke();
      }
    } else {
      ctx.fillStyle = pal.bg;
      ctx.fill();
      shape(ctx, c.type, x, y, -2);
      ctx.fillStyle = stale ? pal.bg : body;
      ctx.fill();
      if (stale) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = body;
        shape(ctx, c.type, x, y, -1);
        ctx.stroke();
      }
    }
    if (repeater && !stale) {
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, 2 * Math.PI);
      ctx.fillStyle = pal.bg;
      ctx.fill();
    }
    const g = glyph(c);
    if (g.text) {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = g.emoji ? `13px ${pal.font}` : `600 10px ${pal.font}`;
      ctx.fillStyle = stale ? fill : ink;
      ctx.fillText(g.text, x, y + (g.emoji ? 1 : 0.5));
    }
    ctx.globalAlpha = 1;

    const number = this.data.numbers[c.key];
    if (number) {
      ctx.font = `600 10px ${pal.font}`;
      const text = String(number);
      const w = Math.max(16, ctx.measureText(text).width + 12);
      roundRect(ctx, x + 2, y - 19, w, 16, 8);
      ctx.fillStyle = pal.bg;
      ctx.fill();
      roundRect(ctx, x + 4, y - 17, w - 4, 12, 6);
      ctx.fillStyle = pal.accent;
      ctx.fill();
      ctx.fillStyle = pal.accentInk;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, x + 2 + w / 2, y - 10.5);
    }
  }

  private circle(ctx: CanvasRenderingContext2D, pal: Palette, d: Drawn, selected: boolean): void {
    const { x, y, r } = d;
    ctx.beginPath();
    ctx.arc(x, y, r + (selected ? 4 : 2), 0, 2 * Math.PI);
    ctx.lineWidth = selected ? 2 : 4;
    ctx.strokeStyle = selected ? pal.accent : pal.groupGlow;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y + 1, r + 0.5, 0, 2 * Math.PI);
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.fillStyle = pal.bg;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, r - 2, 0, 2 * Math.PI);
    ctx.fillStyle = pal.groupFill;
    ctx.fill();
    ctx.font = `600 12px ${pal.font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = pal.accentInk;
    ctx.fillText(String(d.group.members.length), x, y + 0.5);
  }
}
