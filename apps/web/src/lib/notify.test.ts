import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { Capacitor } from "@capacitor/core";
import type { ScheduleOptions } from "@capacitor/local-notifications";
import { askPermissionOnce, conversationIsVisible, notify, tellWatch } from "./notify.js";

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
    { name: "LocalNotifications", methods: ["schedule", "checkPermissions", "requestPermissions"].map((name) => ({ name, rtype: "promise" })) },
    { name: "MeshWatch", methods: [{ name: "configure", rtype: "promise" }] },
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

test("an iOS message outside the open chat reaches the native notifier with sound", async () => {
  const nav = { section: "chats", conversation: "ch:0" } as const;
  assert.equal(conversationIsVisible("ch:1", nav), false);
  await notify("Field team", "New message", "c:ch:1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.plugin, "LocalNotifications");
  assert.equal(calls[0]?.method, "schedule");
  const notice = (calls[0]?.options as ScheduleOptions).notifications[0];
  assert.equal(notice?.sound, "default");
  assert.equal(notice?.foreground, true);
  assert.deepEqual(notice?.extra, { tag: "c:ch:1" });
});

test("only a visible, focused chat suppresses its incoming messages", () => {
  const nav = { section: "chats", conversation: "ch:0" } as const;
  assert.equal(conversationIsVisible("ch:0", nav), true);
  assert.equal(conversationIsVisible("ch:0", { ...nav, section: "settings" }), false);
  page.visibilityState = "hidden";
  // WKWebView may still report focus after the phone locks.
  assert.equal(conversationIsVisible("ch:0", nav), false);
  page.visibilityState = "visible";
  page.hasFocus = () => false;
  assert.equal(conversationIsVisible("ch:0", nav), false);
});

test("an iOS notice is also scheduled when the page is hidden", async () => {
  page.visibilityState = "hidden";
  await notify("Field team", "New message", "c:ch:1");
  assert.equal(calls.length, 1);
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

test("Android keeps its default sound and does not call the iOS watch", async () => {
  platform = "android";
  await tellWatch();
  await notify("Field team", "New message", "c:ch:1");
  assert.equal(calls.length, 1);
  const notice = (calls[0]?.options as ScheduleOptions).notifications[0];
  assert.equal(notice?.sound, undefined);
  assert.equal(notice?.foreground, undefined);
});
