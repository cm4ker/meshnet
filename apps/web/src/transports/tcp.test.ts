import { test } from "node:test";
import assert from "node:assert/strict";
import { addressDevice, parseAddress } from "./tcp.js";

test("an address without a port gets the firmware's 5000", () => {
  assert.deepEqual(parseAddress("192.168.1.50"), { host: "192.168.1.50", port: 5000 });
  assert.deepEqual(parseAddress("  radio.local "), { host: "radio.local", port: 5000 });
});

test("a port after the host is kept", () => {
  assert.deepEqual(parseAddress("192.168.1.50:5001"), { host: "192.168.1.50", port: 5001 });
});

test("IPv6 is whole without a port and bracketed with one", () => {
  assert.deepEqual(parseAddress("fe80::1"), { host: "fe80::1", port: 5000 });
  assert.deepEqual(parseAddress("[fe80::1]:5001"), { host: "fe80::1", port: 5001 });
});

test("an empty address, or a port that is not a number, is refused", () => {
  assert.equal(parseAddress(""), null);
  assert.equal(parseAddress("radio:abc"), null);
  assert.equal(parseAddress(":5000"), null);
});

test("the label drops the default port, so one radio is remembered once", () => {
  assert.equal(addressDevice("192.168.1.50:5000")?.id, "192.168.1.50");
  assert.equal(addressDevice("192.168.1.50")?.id, "192.168.1.50");
  assert.equal(addressDevice("[fe80::1]:5001")?.id, "[fe80::1]:5001");
});
