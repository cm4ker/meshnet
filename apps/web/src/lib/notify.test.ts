import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { Capacitor } from "@capacitor/core";
import type { Notice } from "./announce.js";
import { dismissBanner, getBanner, showBanner } from "./banner.js";
import type { NativeNotice } from "./nativeNotices.js";
import { DEFAULT_PREFS, setNoticePrefs } from "./noticePrefs.js";
import { askPermissionOnce, noticeId, notify, pageOnScreen, tellWatch, unwatchRadio, watchRadio, withdraw } from "./notify.js";

const calls: { plugin: string; method: string; options: unknown }[] = [];
let platform = "ios";
const page = { visibilityState: "visible", hasFocus: () => true };
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

// Exercise the real Capacitor proxy up to the native boundary. This catches
// notices discarded by our code before they ever reach the native plugin.
const methods = (plugin: string, names: string[]) => ({ name: plugin, methods: names.map((name) => ({ name, rtype: "promise" })) });
Object.assign(Capacitor, {
  isNativePlatform: () => true,
  getPlatform: () => platform,
  PluginHeaders: [
    methods("LocalNotifications", ["checkPermissions", "requestPermissions", "removeDeliveredNotificationsById"]),
    methods("MeshWatch", ["configure", "announced", "follow", "post", "chime", "openSettings"]),
    methods("Notices", ["post", "cancel", "chime", "channels", "openSettings"]),
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

const channelMessage: Notice = {
  title: "Alice in Field team",
  body: "New message",
  tag: "c:ch:1",
  kind: "chats",
  face: { name: "Alice" },
  thread: { title: "Field team", group: true, face: { name: "Field team", channel: true }, lines: [{ sender: "Alice", text: "New message", at: 1 }] },
};

/** Lets calls the page does not wait for (the pref subscription's, the banner's signal) reach the native side. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

// The first native call imports the plugin layer; done once here, it is not racing the first test.
before(async () => {
  await tellWatch();
});

beforeEach(async () => {
  setNoticePrefs({ shownBy: DEFAULT_PREFS.shownBy, signal: DEFAULT_PREFS.signal });
  dismissBanner();
  await settle();
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

test("an iOS message goes to the native side with the app's signal and its thread", async () => {
  await notify(channelMessage);
  assert.equal(calls[0]?.plugin, "MeshWatch");
  assert.equal(calls[0]?.method, "post");
  const native = calls[0]?.options as NativeNotice;
  assert.equal(native.sound, "signal_chirp.wav");
  assert.equal(native.tag, "c:ch:1");
  assert.equal(native.id, noticeId("c:ch:1"));
  assert.equal(native.thread?.title, "Field team");
  assert.equal(native.thread?.group, true);
  assert.deepEqual(native.thread?.lines.map((l) => l.sender), ["Alice"]);
  // No canvas under the tests: the circles are left out, not made up.
  assert.equal(native.avatar, null);
});

test("an iOS notice the page shows withdraws the native watch's stand-in for it, after it is posted", async () => {
  await notify(channelMessage);
  assert.deepEqual(calls.map(({ plugin, method, options }) => ({ plugin, method, tag: method === "announced" ? options : undefined })), [
    { plugin: "MeshWatch", method: "post", tag: undefined },
    { plugin: "MeshWatch", method: "announced", tag: { tag: "c:ch:1" } },
  ]);
});

test("a quiet signal posts a notice without a sound", async () => {
  setNoticePrefs({ signal: "none" });
  await settle();
  calls.length = 0;
  await notify(channelMessage);
  assert.equal((calls[0]?.options as NativeNotice).sound, null);
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
  await notify(channelMessage);
  await notify({ ...channelMessage, title: "Field team · 2 new", body: "one\ntwo" });
  await withdraw("c:ch:1");
  const ids = calls.filter((c) => c.method === "post").map((c) => (c.options as NativeNotice).id);
  assert.deepEqual(ids, [noticeId("c:ch:1"), noticeId("c:ch:1")]);
  assert.notEqual(noticeId("c:ch:1"), noticeId("c:ch:2"));
  assert.ok(noticeId("c:ch:1") > 0);
  assert.deepEqual(calls.at(-1), { plugin: "LocalNotifications", method: "removeDeliveredNotificationsById", options: { ids: [noticeId("c:ch:1")] } });
});

test("with the app's own notices, a phone on screen shows a banner and plays the signal, not a system notice", async () => {
  setNoticePrefs({ shownBy: "app" });
  await settle();
  calls.length = 0;
  await notify(channelMessage);
  // The signal plays alongside the banner, not before it shows.
  await settle();
  assert.equal(getBanner()?.notice.tag, "c:ch:1");
  assert.deepEqual(calls.map((c) => [c.plugin, c.method]), [["MeshWatch", "chime"]]);
  assert.deepEqual(calls[0]?.options, { signal: "chirp" });
});

test("with the app's own notices, a hidden phone app still gets the system's", async () => {
  setNoticePrefs({ shownBy: "app" });
  await settle();
  calls.length = 0;
  page.visibilityState = "hidden";
  await notify(channelMessage);
  assert.equal(calls.filter((c) => c.method === "post").length, 1);
});

test("a banner goes when what it said is withdrawn, and only then", async () => {
  showBanner(channelMessage);
  await withdraw("c:ch:2");
  assert.equal(getBanner()?.notice.tag, "c:ch:1");
  await withdraw("c:ch:1");
  assert.equal(getBanner(), null);
});

test("the first connection checks and requests notification permission", async () => {
  await askPermissionOnce();
  assert.deepEqual(calls.map(({ plugin, method }) => ({ plugin, method })), [
    { plugin: "LocalNotifications", method: "checkPermissions" },
    { plugin: "LocalNotifications", method: "requestPermissions" },
  ]);
});

test("the native watch receives notification preferences and the signal without treating its proxy as a Promise", async () => {
  await tellWatch();
  assert.deepEqual(calls, [
    { plugin: "MeshWatch", method: "configure", options: { messages: true, nodes: true, people: true, sound: "signal_chirp.wav" } },
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

test("Android makes its channels ring with the signal, posts through its own plugin and withdraws there, never calling the iOS watch", async () => {
  platform = "android";
  await tellWatch();
  await notify(channelMessage);
  await withdraw("c:ch:1");
  assert.deepEqual(calls.map((c) => `${c.plugin}.${c.method}`), ["Notices.channels", "Notices.post", "Notices.cancel"]);
  assert.deepEqual(calls[0]?.options, { sound: "signal_chirp.wav" });
  const native = calls[1]?.options as NativeNotice;
  assert.equal(native.kind, "chats");
  assert.equal(native.sound, "signal_chirp.wav");
  assert.deepEqual(calls[2]?.options, { id: noticeId("c:ch:1") });
});
