/**
 * Opening the map's tools from wherever a tap starts one: a node's card or
 * profile, a line on the map, a long press. Each goes to the Mesh section so
 * the map is in view, and says what went wrong when it cannot start.
 */

import { AdvType, contactRoute, type SessionState } from "@meshnet/meshcore";
import { askWhoHears } from "./hears.js";
import { contactEnd, relayOf, selfEnd, type MapHandle } from "./mapOverlay.js";
import { getMeshTool, setMeshTool, type LosEnd } from "./meshTool.js";
import { focusOnMap, getNav, showOnMap } from "./nav.js";
import { clearPing, getPing } from "./ping.js";
import { session } from "./session.js";
import { toast } from "./toast.js";

/** The line of sight between two ends, over the map; `back` is the node whose card to return to. */
export function openLineOfSight(from: LosEnd, to: LosEnd, back: string | null, heard: [number, number] | null = null): void {
  if (back) showOnMap(back);
  else focusOnMap(null);
  setMeshTool({ kind: "los", from, to, back, heard });
}

/** A long press on the map: the line of sight from this radio to that spot. */
export function lineOfSightTo(lat: number, lon: number): void {
  const from = selfEnd(session.getState());
  if (!from) {
    toast("Set this radio's position first: Radio › Name and position.");
    return;
  }
  // Held while a node's card was open, Back returns to the card.
  const tool = getMeshTool();
  const back = tool?.kind === "los" ? tool.back : getNav().meshFocus;
  openLineOfSight(from, { lat, lon, name: "This spot", key: null }, back);
}

/**
 * Changes the route to a contact on the map, starting from `relays`, or from
 * the one the radio holds. A relay whose hash names nobody for sure stays in
 * it as that hash.
 */
export function changeRoute(key: string, relays?: string[]): void {
  const state = session.getState();
  const contact = state.contacts[key];
  if (!contact) return;
  if (!contactEnd(contact)) {
    toast("It has shared no position, so it is not on the map.");
    return;
  }
  const start = relays ?? (contactRoute(contact) ?? []).map((h) => relayOf(h, state.contacts)?.key ?? h);
  showOnMap(key);
  setMeshTool({ kind: "route", key, relays: start });
}

/**
 * A point of the route to `key` dropped on a node: a relay dropped on a
 * repeater gives way to it, and the middle of a leg takes it in. A relay
 * dropped on another node of the route, or on either end, leaves the route.
 * What comes of it is a route being changed, to ping and to save.
 */
export function dropOnRoute(key: string, handle: MapHandle, onto: string): void {
  const state = session.getState();
  const contact = state.contacts[key];
  if (!contact) return;
  const tool = getMeshTool();
  const relays = tool?.kind === "route" && tool.key === key ? tool.relays : handle.relays.map((h) => state.contacts[h]?.key ?? relayOf(h, state.contacts)?.key ?? h);
  const own = handle.kind === "hop" ? relays[handle.index] : undefined;
  if (onto === own) return;
  const inRoute = onto === "self" || onto === key || relays.includes(onto);
  let next: string[];
  if (handle.kind === "hop") {
    next = inRoute ? relays.filter((_, i) => i !== handle.index) : relays.map((k, i) => (i === handle.index ? onto : k));
  } else {
    if (inRoute) return;
    next = [...relays.slice(0, handle.index), onto, ...relays.slice(handle.index)];
  }
  if (!inRoute && state.contacts[onto]?.type !== AdvType.Repeater) {
    toast("Only repeaters pass messages on.");
    return;
  }
  changeRoute(key, next);
}

/** A tap on a node while a route is being changed adds it, or takes it off; says whether the tap was taken. */
export function tapInRoute(key: string | null, state: SessionState): boolean {
  const tool = getMeshTool();
  if (tool?.kind !== "route") return false;
  if (!key || key === tool.key) return true;
  const c = state.contacts[key];
  if (!c || c.type !== AdvType.Repeater) {
    if (c) toast("Only repeaters pass messages on.");
    return true;
  }
  const relays = tool.relays.includes(key) ? tool.relays.filter((k) => k !== key) : [...tool.relays, key];
  setMeshTool({ ...tool, relays });
  return true;
}

export function whoHearsMe(): void {
  focusOnMap(null);
  setMeshTool({ kind: "hears" });
  void askWhoHears();
}

/** Puts the tool away, back to the node it was opened from; a ping along a route that was not saved goes with it. */
export function closeTool(): void {
  const tool = getMeshTool();
  setMeshTool(null);
  if (tool?.kind === "los" && tool.back) showOnMap(tool.back);
  else if (tool?.kind === "route") {
    if (getPing(tool.key)?.via) clearPing(tool.key);
    showOnMap(tool.key);
  }
}
