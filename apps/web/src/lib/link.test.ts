import { test } from "node:test";
import assert from "node:assert/strict";
import { BaseTransport, type Transport } from "@meshnet/meshcore";
import type { Connector, FoundDevice } from "../transports/types.js";
import { connectWith, disconnect, getLink } from "./link.js";
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
