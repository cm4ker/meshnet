/**
 * What the map is being used for besides picking a node: a line of sight
 * between two points, a route being changed by tapping repeaters, or the
 * answers to "who hears me". One at a time; the sheet on a phone and the
 * panel on a desktop show it, and the map draws it. It lives only while the
 * app runs, like the map's own view.
 */

import { useSyncExternalStore } from "react";

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
    }
  /** `relays` are contact keys, in order from this radio. */
  | { kind: "route"; key: string; relays: string[] }
  | { kind: "hears" };

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
