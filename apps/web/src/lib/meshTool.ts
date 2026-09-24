/**
 * What the map is being used for besides picking a node: a line of sight
 * between two points, the route to a contact, or the answers to "who hears
 * me". One at a time; the sheet on a phone and the panel on a desktop show
 * it, and the map draws it. It lives only while the app runs, like the map's
 * own view.
 */

import { useSyncExternalStore } from "react";
import type { Section } from "./nav.js";

/** One end of a line of sight: a node, this radio, or a spot on the map. */
export interface LosEnd {
  lat: number;
  lon: number;
  name: string;
  /** A contact's key, "self" for this radio, null for a spot. */
  key: string | null;
}

export type MeshTool =
  | {
      kind: "los";
      from: LosEnd;
      to: LosEnd;
      /** The node whose card it was opened from, to go back to. */
      back: string | null;
      /** How the leg sounded when last pinged, out and back, dB. */
      heard?: [number, number] | null;
      /** The route it was opened from, to go back to. */
      prev?: RouteTool | null;
    }
  | RouteTool
  | { kind: "hears" };

/**
 * The route to a contact. `draft` is a route being changed, contact keys (or
 * hashes naming nobody for sure) in order from this radio; null while the
 * one the radio holds is shown. `returnTo` is the section it was opened
 * from, and the node the map had picked then, to go back to when it closes.
 */
export interface RouteTool {
  kind: "route";
  key: string;
  draft: string[] | null;
  returnTo?: { section: Section; focus: string | null } | null;
}

let tool: MeshTool | null = null;
const listeners = new Set<() => void>();

export function setMeshTool(next: MeshTool | null): void {
  tool = next;
  for (const listener of listeners) listener();
}

export function getMeshTool(): MeshTool | null {
  return tool;
}

export function useMeshTool(): MeshTool | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => tool,
  );
}
