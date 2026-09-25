import { useSyncExternalStore } from "react";
import { contactHops, isFavourite, type ContactRecord, type SessionState } from "@meshnet/meshcore";
import { distanceKm, hasPosition } from "./geo.js";
import { heardAt } from "./nodes.js";
import { readSetting, writeSetting } from "./storage.js";

/**
 * How the Mesh list is ordered, and whether yours and the starred keep their
 * own groups above the rest or fall in with everyone else. Kept on this
 * device, like the theme.
 */

export type NodeOrder = "heard" | "name" | "near" | "relays";

export const NODE_ORDERS: readonly { id: NodeOrder; label: string }[] = [
  { id: "heard", label: "Last heard" },
  { id: "name", label: "Name" },
  { id: "near", label: "Nearest" },
  { id: "relays", label: "Fewest relays" },
];

export interface NodeOrderPrefs {
  order: NodeOrder;
  /** Yours and favourites in groups of their own, above the rest. */
  pinned: boolean;
}

const KEY = "meshnet.nodeOrder";

function read(): NodeOrderPrefs {
  const saved = readSetting<Partial<NodeOrderPrefs> | null>(KEY, null);
  const order = NODE_ORDERS.find((o) => o.id === saved?.order)?.id ?? "heard";
  return { order, pinned: typeof saved?.pinned === "boolean" ? saved.pinned : true };
}

let prefs = read();
const listeners = new Set<() => void>();

export function setNodeOrder(patch: Partial<NodeOrderPrefs>): void {
  prefs = { ...prefs, ...patch };
  writeSetting(KEY, prefs);
  for (const listener of listeners) listener();
}

export function getNodeOrder(): NodeOrderPrefs {
  return prefs;
}

export function useNodeOrder(): NodeOrderPrefs {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => prefs,
  );
}

/** Whether this radio knows where it is, which the nearest-first order needs. */
export function placed(self: SessionState["self"]): boolean {
  return !!self && hasPosition(self.lat, self.lon);
}

/** The order in force: without a position of its own the radio cannot say who is nearest, and the list goes by last heard. */
export function orderInForce(order: NodeOrder, self: SessionState["self"]): NodeOrder {
  return order === "near" && !placed(self) ? "heard" : order;
}

const byName = (a: ContactRecord, b: ContactRecord) => (a.name || a.prefix).localeCompare(b.name || b.prefix);
const byHeard = (a: ContactRecord, b: ContactRecord) => heardAt(b) - heardAt(a) || byName(a, b);

/**
 * Compares two nodes in the order. A node without what the order goes by, a
 * position or a route, comes after those with it, and among its like the
 * newest heard first.
 */
export function nodeComparator(order: NodeOrder, self: SessionState["self"]): (a: ContactRecord, b: ContactRecord) => number {
  const by = (measure: (c: ContactRecord) => number) => {
    const known = new Map<string, number>();
    const of = (c: ContactRecord) => {
      let v = known.get(c.key);
      if (v === undefined) known.set(c.key, (v = measure(c)));
      return v;
    };
    // Infinity less Infinity is NaN, which falls through to the last heard like a tie.
    return (a: ContactRecord, b: ContactRecord) => of(a) - of(b) || byHeard(a, b);
  };
  switch (orderInForce(order, self)) {
    case "name":
      return byName;
    case "near":
      return by((c) => (hasPosition(c.lat, c.lon) ? distanceKm(self!.lat, self!.lon, c.lat, c.lon) : Infinity));
    case "relays":
      return by((c) => contactHops(c) ?? Infinity);
    default:
      return byHeard;
  }
}

export interface NodeGroup {
  title: string;
  rows: ContactRecord[];
}

/**
 * The list's groups: yours, the starred and the rest, each in the order; or,
 * with nothing pinned, one list. The rest is named for the order only when
 * something sits above it.
 */
export function nodeGroups(rows: ContactRecord[], yours: (c: ContactRecord) => boolean, pinned: boolean, order: NodeOrder): NodeGroup[] {
  if (!pinned) return [{ title: "", rows }];
  const mine = rows.filter(yours);
  const starred = rows.filter((c) => !yours(c) && isFavourite(c));
  const rest = rows.filter((c) => !yours(c) && !isFavourite(c));
  const restTitle = mine.length || starred.length ? (order === "heard" ? "Heard recently" : "Others") : "";
  return [
    { title: "Yours", rows: mine },
    { title: "Favourites", rows: starred },
    { title: restTitle, rows: rest },
  ].filter((g) => g.rows.length > 0);
}
