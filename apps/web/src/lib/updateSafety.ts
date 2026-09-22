import type { SessionState } from "@meshnet/meshcore";

/** Queued offline messages can wait on disk; an in-flight command or ACK cannot. */
export function radioBusyForUpdate(state: SessionState): boolean {
  return state.syncing || state.remote.active !== null || state.remote.queued.length > 0 || state.messages.some((m) =>
    m.direction === "out" && (m.status === "sending" || (m.status === "sent" && m.ackTag !== null)),
  );
}
