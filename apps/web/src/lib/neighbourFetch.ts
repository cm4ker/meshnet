/**
 * The whole of a repeater's neighbour list, for the map. The page in the
 * node's screens fetches a page at a time by hand; the map asks for the
 * rest itself, one request after another, since half the list drawn would
 * look like all of it. What is fetched lands in the session's list, so the
 * page shows it too. Kept per repeater while the app runs.
 */

import { useSyncExternalStore } from "react";
import { NeighbourOrder, NoReplyError } from "@meshnet/meshcore";
import { errorText } from "../i18n/errors.js";
import { PAGE } from "./neighbours.js";
import { session } from "./session.js";

export interface NeighbourFetch {
  running: boolean;
  /** Why the last request failed; the pages before it stay. */
  error: string | null;
  /** Whether that was no answer at all, rather than a refusal. */
  silent: boolean;
}

const fetches = new Map<string, NeighbourFetch>();
const listeners = new Set<() => void>();

function set(key: string, value: NeighbourFetch): void {
  fetches.set(key, value);
  for (const listener of listeners) listener();
}

export function useNeighbourFetch(key: string): NeighbourFetch | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => fetches.get(key) ?? null,
  );
}

/**
 * Fetches what is missing of `key`'s list, in the order it was fetched in
 * before. `again` starts over from the first page, as "Ask again" does.
 */
export async function fetchAllNeighbours(key: string, again = false): Promise<void> {
  if (fetches.get(key)?.running || session.getState().status !== "ready") return;
  set(key, { running: true, error: null, silent: false });
  try {
    const held = session.getState().neighbours[key];
    const order = held?.order ?? NeighbourOrder.Newest;
    let list = held && !again ? held : await session.requestNeighbours(key, { order, count: PAGE });
    while (list.neighbours.length < list.total) {
      const got = list.neighbours.length;
      list = await session.requestNeighbours(key, { order, offset: got, count: PAGE });
      // A page with nothing new: the list shrank while it was read.
      if (list.neighbours.length <= got) break;
    }
    set(key, { running: false, error: null, silent: false });
  } catch (error) {
    set(key, { running: false, error: errorText(error), silent: error instanceof NoReplyError });
  }
}
