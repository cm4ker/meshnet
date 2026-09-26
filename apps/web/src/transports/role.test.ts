import { test } from "node:test";
import assert from "node:assert/strict";
import { bleAddress, roleOf, sharedRadio, shownName } from "./role.js";
import type { FoundDevice } from "./types.js";

const found = (name: string, extra: Partial<FoundDevice> = {}): FoundDevice => ({ id: "C24A1E77039F", name, detail: null, rssi: -60, ...extra });

test("a Bluetooth radio is known by the firmware's prefix, and shown without it", () => {
  const radio = found("MeshCore-PKIO Companion");
  assert.equal(roleOf(radio, "ble"), "radio");
  assert.equal(shownName(radio, "ble"), "PKIO Companion");
  // A radio that gave no name is still one.
  assert.equal(roleOf(found("MeshCore"), "ble"), "radio");
  assert.equal(shownName(found("MeshCore"), "ble"), "MeshCore");
});

test("a phone sharing its radio is a phone: an iPhone by its advert, Android by its own name", () => {
  const iphone = found("Ommesh PKIO");
  assert.equal(roleOf(iphone, "ble"), "phone");
  assert.equal(shownName(iphone, "ble"), "iPhone");
  assert.equal(sharedRadio(iphone), "PKIO");
  assert.equal(sharedRadio(found("Ommesh")), null);
  const android = found("realme 15T");
  assert.equal(roleOf(android, "ble"), "phone");
  assert.equal(shownName(android, "ble"), "realme 15T");
  assert.equal(sharedRadio(android), null);
});

test("a port or an address is a radio unless its connector says otherwise, and keeps its name", () => {
  assert.equal(roleOf(found("COM7"), "serial"), "radio");
  assert.equal(roleOf(found("COM1", { role: "port" }), "serial"), "port");
  assert.equal(roleOf(found("192.168.1.50"), "tcp"), "radio");
  assert.equal(shownName(found("MeshCore-x"), "serial"), "MeshCore-x");
});

test("the address shown is a Bluetooth address from the detail or the id, never an iOS id", () => {
  assert.equal(bleAddress(found("MeshCore-A", { detail: "C2:4A:1E:77:03:9F" })), "C2:4A:1E:77:03:9F");
  assert.equal(bleAddress(found("MeshCore-A", { id: "c2:4a:1e:77:03:9f" })), "c2:4a:1e:77:03:9f");
  assert.equal(bleAddress(found("MeshCore-A", { id: "7F1C2A44-0B6E-4C1D-9E3A-5B2E1D0C9A11", detail: "connected to this phone" })), null);
});
