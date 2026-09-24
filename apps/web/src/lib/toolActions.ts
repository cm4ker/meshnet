/**
 * Opening the map's tools from wherever a tap starts one: a route row, a
 * line on the map, a point dragged, a long press. Each goes to the Mesh
 * section so the map is in view, and says what went wrong when it cannot
 * start. A tool opened from another section goes back there when it closes.
 */

import { AdvType, contactRoute, type SessionState } from "@meshnet/meshcore";
import { askWhoHears } from "./hears.js";
import { relayOf, selfEnd, type MapHandle } from "./mapOverlay.js";
import { getMeshTool, setMeshTool, type LosEnd, type RouteTool } from "./meshTool.js";
import { focusOnMap, getNav, goSection, showOnMap } from "./nav.js";
import { clearPing, getPing } from "./ping.js";
import { session } from "./session.js";
import { toast } from "./toast.js";

/** The route to a contact, in its sheet over the map. */
export function openRoute(key: string): void {
  const nav = getNav();
  const tool = getMeshTool();
  const returnTo = nav.section !== "mesh" ? { section: nav.section, focus: nav.meshFocus } : tool?.kind === "route" && tool.key === key ? (tool.returnTo ?? null) : null;
  showOnMap(key);
  setMeshTool({ kind: "route", key, draft: null, returnTo });
}

/** The line of sight between two ends, over the map; `back` is the node whose card to return to, or the route it was opened from. */
export function openLineOfSight(from: LosEnd, to: LosEnd, back: string | null, heard: [number, number] | null = null): void {
  const current = getMeshTool();
  const prev = current?.kind === "route" ? current : current?.kind === "los" ? (current.prev ?? null) : null;
  if (back) showOnMap(back);
  else focusOnMap(null);
  setMeshTool({ kind: "los", from, to, back, heard, prev });
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

/** The relays of the route the radio holds for a contact, as contact keys where a hash names one for sure. */
function heldRelays(key: string, state: SessionState): string[] {
  const contact = state.contacts[key];
  return (contact ? (contactRoute(contact) ?? []) : []).map((h) => relayOf(h, state.contacts)?.key ?? h);
}

/** The route to `key` being changed to `draft`, in its sheet. */
function editRoute(key: string, draft: string[]): void {
  const tool = getMeshTool();
  const route: RouteTool = tool?.kind === "route" && tool.key === key ? tool : { kind: "route", key, draft: null, returnTo: null };
  if (getNav().section !== "mesh" || getNav().meshFocus !== key) showOnMap(key);
  setMeshTool({ ...route, draft });
}

/**
 * A point of the route to `key` dropped on a node: a relay dropped on a
 * repeater gives way to it, and the middle of a leg takes it in. A relay
 * dropped on another node of the route, or on either end, leaves the route.
 * What comes of it is a route being changed, to check and to save.
 */
export function dropOnRoute(key: string, handle: MapHandle, onto: string): void {
  const state = session.getState();
  const contact = state.contacts[key];
  if (!contact) return;
  const tool = getMeshTool();
  const relays = tool?.kind === "route" && tool.key === key && tool.draft ? tool.draft : handle.relays.map((h) => state.contacts[h]?.key ?? relayOf(h, state.contacts)?.key ?? h);
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
  editRoute(key, next);
}

/** A tap on a node while a route is open adds it to the route, or takes it off; says whether the tap was taken. */
export function tapInRoute(key: string | null, state: SessionState): boolean {
  const tool = getMeshTool();
  if (tool?.kind !== "route") return false;
  if (!key || key === tool.key) return true;
  const c = state.contacts[key];
  if (!c || c.type !== AdvType.Repeater) {
    if (c) toast("Only repeaters pass messages on.");
    return true;
  }
  const relays = tool.draft ?? heldRelays(tool.key, state);
  setMeshTool({ ...tool, draft: relays.includes(key) ? relays.filter((k) => k !== key) : [...relays, key] });
  return true;
}

/** Leaves a route being changed as it was; what was checked along it goes with it. */
export function cancelRouteEdit(): void {
  const tool = getMeshTool();
  if (tool?.kind !== "route") return;
  if (getPing(tool.key)?.via) clearPing(tool.key);
  setMeshTool({ ...tool, draft: null });
}

export function whoHearsMe(): void {
  focusOnMap(null);
  setMeshTool({ kind: "hears" });
  void askWhoHears();
}

/**
 * Puts the tool away, one step: a line of sight back to the route it was
 * opened from, or to the node's card; a route back to where it was opened,
 * and a check along a change that was not saved goes with it.
 */
export function closeTool(): void {
  const tool = getMeshTool();
  if (tool?.kind === "los" && tool.prev) {
    setMeshTool(tool.prev);
    return;
  }
  setMeshTool(null);
  if (tool?.kind === "los" && tool.back) showOnMap(tool.back);
  else if (tool?.kind === "route") {
    if (getPing(tool.key)?.via) clearPing(tool.key);
    if (tool.returnTo) {
      focusOnMap(tool.returnTo.focus);
      goSection(tool.returnTo.section);
    } else {
      showOnMap(tool.key);
    }
  }
}

/** Puts every tool away at once, as a close button does. */
export function closeAllTools(): void {
  const tool = getMeshTool();
  if (tool?.kind === "los" && tool.prev) {
    setMeshTool(tool.prev);
    closeTool();
  } else {
    setMeshTool(null);
  }
}
