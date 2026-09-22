import { test } from "node:test";
import assert from "node:assert/strict";
import { MeshSession, type SessionState } from "@meshnet/meshcore";
import { radioBusyForUpdate } from "./updateSafety.js";

test("installation waits for outgoing messages, ACKs, sync and remote jobs", () => {
  const state = new MeshSession().getState();
  assert.equal(radioBusyForUpdate(state), false);
  assert.equal(radioBusyForUpdate({ ...state, syncing: true }), true);
  for (const [status, ackTag, busy] of [["queued", null, false], ["sending", null, true], ["sent", 7, true], ["sent", null, false], ["delivered", 7, false], ["unconfirmed", 7, false]] as const) {
    assert.equal(radioBusyForUpdate({ ...state, messages: [{ direction: "out", status, ackTag } as SessionState["messages"][number]] }), busy, status);
  }
  assert.equal(radioBusyForUpdate({ ...state, remote: { ...state.remote, queued: [{} as typeof state.remote.queued[number]] } }), true);
  assert.equal(radioBusyForUpdate({ ...state, remote: { ...state.remote, active: {} as NonNullable<typeof state.remote.active> } }), true);
});
