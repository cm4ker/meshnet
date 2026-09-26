import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeLpp } from "./lpp.js";

test("voltage and current come signed, as the firmware's CayenneLPP 1.6.1 writes them", () => {
  // Channel 4 of an INA sensor: 3.48 V, and 16 mA flowing back into the battery.
  const readings = decodeLpp(new Uint8Array([4, 0x74, 0x01, 0x5c, 4, 0x75, 0xff, 0xf0, 4, 0x75, 0x00, 0x77]));
  assert.deepEqual(readings, [
    { channel: 4, type: "voltage", volts: 3.48 },
    { channel: 4, type: "current", amps: -0.016 },
    { channel: 4, type: "current", amps: 0.119 },
  ]);
});
