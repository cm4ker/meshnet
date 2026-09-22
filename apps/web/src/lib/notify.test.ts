import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { Capacitor } from "@capacitor/core";
import type { ScheduleOptions } from "@capacitor/local-notifications";
import { askPermissionOnce, noticeId, notify, pageOnScreen, tellWatch, unwatchRadio, watchRadio, withdraw } from "./notify.js";

const calls: { plugin: string; method: string; options: unknown }[] = [];
let platform = "ios";
const page = { visibilityState: "visible", hasFocus: () => true };
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

// Exercise the real Capacitor proxy up to the native boundary. This catches
// notices discarded by our code before they ever reach the iOS plugin.
Object.assign(Capacitor, {
  isNativePlatform: () => true,
  getPlatform: () => platform,
  PluginHeaders: [
    { name: "LocalNotifications", methods: ["schedule", "checkPermissions", "requestPermissions", "removeDeliveredNotificationsById"].map((name) => ({ name, rtype: "promise" })) },
    { name: "MeshWatch", methods: ["configure", "announced", "follow"].map((name) => ({ name, rtype: "promise" })) },
  ],
  nativePromise: async (plugin: string, method: string, options: unknown) => {
    calls.push({ plugin, method, options });
    if (method === "checkPermissions") return { display: "prompt" };
    if (method === "requestPermissions") return { display: "granted" };
    return {};
  },
});
Object.defineProperty(globalThis, "window", { configurable: true, value: { Capacitor } });
Object.defineProperty(globalThis, "document", { configurable: true, value: page });

beforeEach(() => {
  calls.length = 0;
  platform = "ios";
  page.visibilityState = "visible";
  page.hasFocus = () => true;
});

after(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
});

test("an iOS message reaches the native notifier with sound", async () => {
  await notify("Field team", "New message", "c:ch:1");
  assert.equal(calls[0]?.plugin, "LocalNotifications");
  assert.equal(calls[0]?.method, "schedule");
  const notice = (calls[0]?.options as ScheduleOptions).notifications[0];
  assert.equal(notice?.sound, "default");
  assert.equal(notice?.foreground, true);
  assert.deepEqual(notice?.extra, { tag: "c:ch:1" });
});

test("an iOS notice the page shows withdraws the native watch's stand-in for it, after it is scheduled", async () => {
  await notify("Field team", "New message", "c:ch:1");
  assert.deepEqual(calls.map(({ plugin, method, options }) => ({ plugin, method, tag: method === "announced" ? options : undefined })), [
    { plugin: "LocalNotifications", method: "schedule", tag: undefined },
    { plugin: "MeshWatch", method: "announced", tag: { tag: "c:ch:1" } },
  ]);
});

test("a phone's page is on screen while it is visible, whatever it says about focus", () => {
  assert.equal(pageOnScreen(), true);
  page.hasFocus = () => false;
  assert.equal(pageOnScreen(), true);
  // WKWebView may still report focus after the phone locks.
  page.hasFocus = () => true;
  page.visibilityState = "hidden";
  assert.equal(pageOnScreen(), false);
});

test("a notice keeps one id per tag, so the next replaces it and a withdrawal finds it", async () => {
  await notify("Field team", "New message", "c:ch:1");
  await notify("Field team · 2 new", "one\ntwo", "c:ch:1");
  await withdraw("c:ch:1");
  const ids = calls.filter((c) => c.method === "schedule").map((c) => (c.options as ScheduleOptions).notifications[0]?.id);
  assert.deepEqual(ids, [noticeId("c:ch:1"), noticeId("c:ch:1")]);
  assert.notEqual(noticeId("c:ch:1"), noticeId("c:ch:2"));
  assert.ok(noticeId("c:ch:1") > 0);
  assert.deepEqual(calls.at(-1), { plugin: "LocalNotifications", method: "removeDeliveredNotificationsById", options: { ids: [noticeId("c:ch:1")] } });
});

test("an iOS notice is also scheduled when the page is hidden", async () => {
  page.visibilityState = "hidden";
  await notify("Field team", "New message", "c:ch:1");
  assert.equal(calls.filter((c) => c.method === "schedule").length, 1);
});

test("the first connection checks and requests iOS notification permission", async () => {
  await askPermissionOnce();
  assert.deepEqual(calls.map(({ plugin, method }) => ({ plugin, method })), [
    { plugin: "LocalNotifications", method: "checkPermissions" },
    { plugin: "LocalNotifications", method: "requestPermissions" },
  ]);
});

test("the native watch receives notification preferences without treating its proxy as a Promise", async () => {
  await tellWatch();
  assert.deepEqual(calls, [
    { plugin: "MeshWatch", method: "configure", options: { messages: true, nodes: true } },
  ]);
});

test("the native watch follows the radio the page connected to, and a radio let go only while it is the one followed", async () => {
  await watchRadio("A");
  await watchRadio("B");
  // The old radio's link closes after the new one opened.
  await unwatchRadio("A");
  await unwatchRadio("B");
  assert.deepEqual(calls, [
    { plugin: "MeshWatch", method: "follow", options: { deviceId: "A" } },
    { plugin: "MeshWatch", method: "follow", options: { deviceId: "B" } },
    { plugin: "MeshWatch", method: "follow", options: {} },
  ]);
});

test("Android keeps its default sound and does not call the iOS watch", async () => {
  platform = "android";
  await tellWatch();
  await notify("Field team", "New message", "c:ch:1");
  assert.equal(calls.length, 1);
  const notice = (calls[0]?.options as ScheduleOptions).notifications[0];
  assert.equal(notice?.sound, undefined);
  assert.equal(notice?.foreground, undefined);
});
