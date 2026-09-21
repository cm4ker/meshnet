/**
 * The one session, and the hooks that read it.
 *
 * `useSyncExternalStore` over the session's snapshot: every component that
 * reads state re-renders on every change, which is fine for a client whose
 * whole state is a few hundred rows.
 */

import { useSyncExternalStore } from "react";
import { MeshSession, type SessionState } from "@meshnet/meshcore";
import { IndexedDbStorage } from "./storage.js";
import { pushTrace } from "./trace.js";

export const storage = new IndexedDbStorage();

export const session = new MeshSession({
  appName: "Meshnet",
  storage,
  trace: pushTrace,
});

export function useSession(): SessionState {
  return useSyncExternalStore(
    (listener) => session.subscribe(listener),
    () => session.getState(),
  );
}

export function useSelector<T>(select: (state: SessionState) => T): T {
  return useSyncExternalStore(
    (listener) => session.subscribe(listener),
    () => select(session.getState()),
  );
}
