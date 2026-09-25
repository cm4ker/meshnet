import { test } from "node:test";
import assert from "node:assert/strict";
import { BaseTransport, type Transport } from "@meshnet/meshcore";
import type { Connector, FoundDevice } from "../transports/types.js";
import { connectWith, disconnect, getLink, reconnectNow } from "./link.js";
import { demoConnector } from "../transports/demo.js";
import { session } from "./session.js";

class IdleRadio extends BaseTransport {
  readonly kind = "ble" as const;
  shut = false;
  constructor(readonly label: string) {
    super();
  }
  async send(): Promise<void> {}
  protected async shutdown(): Promise<void> {
    this.shut = true;
  }
}

/** A connector whose every connect waits until the test answers it. */
function slowConnector(): { connector: Connector; answer: (transport: Transport) => void } {
  const waiting: ((transport: Transport) => void)[] = [];
  const connector: Connector = {
    id: "slow",
    kind: "ble",
    title: "Slow",
    description: "",
    mode: "scan",
    remembered: async () => [],
    connect: () => new Promise<Transport>((resolve) => waiting.push(resolve)),
  };
  return { connector, answer: (transport) => waiting.shift()?.(transport) };
}

const radio = (name: string): FoundDevice => ({ id: name, name, detail: null, rssi: null });

test("a radio given up while it was still connecting is let go when it answers, not handed to the session", async () => {
  const { connector, answer } = slowConnector();
  const attempt = connectWith(connector, radio("Node-21"));
  await disconnect();
  const late = new IdleRadio("Node-21");
  answer(late);
  await attempt;
  // The late link is closed on the next turns.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(late.shut, true);
  assert.equal(session.getState().link, null);
  assert.equal(getLink().phase, "idle");
});

/** Turns of the event loop until `done`, for a radio that answers on timers. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 2_000 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(done(), "gave up waiting");
}

test("a dropped link is tried again for as long as the radio stays away, and comes back with it", async () => {
  let away = false;
  const tries: string[] = [];
  const connector: Connector = {
    ...demoConnector,
    id: "flaky",
    connect: async (device) => {
      tries.push(away ? "away" : "there");
      if (away) throw new Error("not in range");
      return demoConnector.connect(device);
    },
  };
  await connectWith(connector, radio("MeshCore-demo"));
  assert.equal(getLink().phase, "connected");

  away = true;
  await session.reboot();
  // Past the six tries the loop used to give up after, each brought forward rather than waited out.
  for (let i = 0; i < 10; i++) {
    await until(() => getLink().waiting);
    assert.equal(getLink().phase, "connecting");
    reconnectNow();
  }
  await until(() => getLink().waiting);
  away = false;
  reconnectNow();
  await until(() => getLink().phase === "connected");
  assert.equal(session.getState().status, "ready");
  assert.equal(tries.filter((t) => t === "away").length, 10);
  await disconnect();
});
