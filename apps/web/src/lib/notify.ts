/**
 * System notifications, for a message outside the visible chat or a node
 * heard for the first time. Each shell draws them its own way:
 *
 * - a browser tab, with the Web Notification API;
 * - the desktop shell, natively (`announce.rs`), since WebView2 draws none;
 * - the phone app, with Capacitor's local notifications, since neither
 *   WKWebView nor Android's WebView has a `Notification` at all. On iOS the
 *   page's scripts are suspended soon after the app leaves the screen, so a
 *   native watch (`MeshWatch.swift`) announces what the radio pushes while
 *   the phone is locked; the page tells it which notices are wanted.
 *
 * Each notice carries a tag saying what it is about, `c:<conversation>` or
 * `n:<contact key>`, and a click on it hands the tag back to open that. A
 * notice replaces the one out with its tag, and `withdraw` takes it back
 * once what it was about has been read.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { nativePlatform, shell } from "./platform.js";
import { readSetting, writeSetting } from "./storage.js";

const MESSAGES_KEY = "meshnet.notify";
const NODES_KEY = "meshnet.notify.nodes";

export function notificationsWanted(): boolean {
  return readSetting<boolean>(MESSAGES_KEY, true);
}

export function setNotificationsWanted(on: boolean): void {
  writeSetting(MESSAGES_KEY, on);
  void tellWatch();
}

export function nodeNotificationsWanted(): boolean {
  return readSetting<boolean>(NODES_KEY, true);
}

export function setNodeNotificationsWanted(on: boolean): void {
  writeSetting(NODES_KEY, on);
  void tellWatch();
}

/**
 * The iPhone's native watch (`MeshWatch.swift`): it announces what the radio
 * pushes while the page is asleep in the background, as a stand-in that waits
 * a few seconds for the page to announce the same thing itself.
 */
interface MeshWatchPlugin {
  configure(options: { messages: boolean; nodes: boolean }): Promise<void>;
  /** The page has announced this tag itself, so the watch withdraws its own notice for it. */
  announced(options: { tag: string }): Promise<void>;
}

let watch: MeshWatchPlugin | null = null;

/** Runs `use` with the watch, on an iPhone only. */
async function withWatch(use: (watch: MeshWatchPlugin) => Promise<void>): Promise<void> {
  if (shell() !== "capacitor" || nativePlatform() !== "ios") return;
  const { registerPlugin } = await import("@capacitor/core");
  // A Capacitor plugin is a Proxy that manufactures methods for every
  // property, including `then`. Never resolve a Promise with that proxy:
  // Promise assimilation calls the nonexistent native `then` and hangs.
  watch ??= registerPlugin<MeshWatchPlugin>("MeshWatch");
  await use(watch);
}

/** Hands the two switches to the watch, which cannot read the page's storage. */
export async function tellWatch(): Promise<void> {
  try {
    await withWatch((w) => w.configure({ messages: notificationsWanted(), nodes: nodeNotificationsWanted() }));
  } catch (error) {
    console.warn("Could not configure iOS background notifications", error);
  }
}

type LocalNotificationsModule = typeof import("@capacitor/local-notifications");

let local: Promise<LocalNotificationsModule> | null = null;
function localNotifications(): Promise<LocalNotificationsModule> {
  // Resolve with the module, never the thenable native plugin proxy inside it.
  local ??= import("@capacitor/local-notifications");
  return local;
}

/**
 * Whether notices may be shown, asking the system when it has not been
 * asked. The desktop shell needs no permission for a toast.
 */
export async function askPermission(): Promise<boolean> {
  switch (shell()) {
    case "tauri":
      return true;
    case "capacitor": {
      const { LocalNotifications: api } = await localNotifications();
      const { display } = await api.checkPermissions();
      if (display === "granted") return true;
      if (display === "denied") return false;
      return (await api.requestPermissions()).display === "granted";
    }
    default:
      if (!("Notification" in window)) return false;
      if (Notification.permission === "granted") return true;
      if (Notification.permission === "denied") return false;
      return (await Notification.requestPermission()) === "granted";
  }
}

/**
 * The phone asks once, the first time there is a radio to hear from: its
 * notifications are on by default, and a default the system was never asked
 * about shows nothing. A browser asks only when the switch is moved, since
 * a prompt out of nowhere is what browsers learn to block.
 */
export async function askPermissionOnce(): Promise<void> {
  if (shell() !== "capacitor") return;
  if (!notificationsWanted() && !nodeNotificationsWanted()) return;
  await askPermission().catch(() => false);
}

/**
 * Whether the reader can see the page: shown, and on a computer, in the
 * window in front. A phone's page is either on screen or hidden; WKWebView
 * may even report focus after the phone locks, so a phone goes by
 * visibility alone.
 */
export function pageOnScreen(): boolean {
  if (document.visibilityState !== "visible") return false;
  return shell() === "capacitor" || document.hasFocus();
}

/**
 * The phone's number for the notice with this tag, the same every time, so
 * a notice replaces the one out with its tag and can be withdrawn by it.
 * FNV-1a, kept positive for Android's `int` ids.
 */
export function noticeId(tag: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < tag.length; i++) {
    hash ^= tag.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash & 0x7fffffff) || 1;
}

/** The browser's notices that are out, by tag, to be closed when withdrawn. */
const shown = new Map<string, Notification>();

/** The caller checks preferences and whether what it announces is already on screen. */
export async function notify(title: string, body: string, tag: string): Promise<void> {
  switch (shell()) {
    case "tauri":
      await invoke("announce", { title, body, tag }).catch(() => undefined);
      return;
    case "capacitor":
      try {
        const { LocalNotifications: api } = await localNotifications();
        await api.schedule({ notifications: [{
          id: noticeId(tag), title, body, extra: { tag },
          // Without a sound iOS delivers silently. A missing named sound
          // uses the system default; Android already supplies its own.
          ...(nativePlatform() === "ios" ? { sound: "default", foreground: true } : {}),
        }] });
      } catch (error) {
        // Nothing shown, so the watch's stand-in, if any, is left to show.
        console.warn("Could not show notification", error);
        return;
      }
      // One notice per message: the watch's "New message" for the same news goes.
      await withWatch((w) => w.announced({ tag })).catch(() => undefined);
      return;
    default:
      if (!("Notification" in window) || Notification.permission !== "granted") return;
      try {
        const notice = new Notification(title, { body, tag });
        notice.onclick = () => {
          window.focus();
          clicked?.(tag);
          notice.close();
        };
        notice.onclose = () => {
          if (shown.get(tag) === notice) shown.delete(tag);
        };
        shown.set(tag, notice);
      } catch {
        // Some webviews throw on construction; there is nothing to do about it.
      }
  }
}

/** Takes back the notice out with this tag, if there is one: what it said has been read. */
export async function withdraw(tag: string): Promise<void> {
  switch (shell()) {
    case "tauri":
      await invoke("withdraw", { tag }).catch(() => undefined);
      return;
    case "capacitor":
      try {
        const { LocalNotifications: api } = await localNotifications();
        await api.removeDeliveredNotificationsById({ ids: [noticeId(tag)] });
      } catch (error) {
        console.warn("Could not withdraw notification", error);
      }
      return;
    default:
      shown.get(tag)?.close();
      shown.delete(tag);
  }
}

let clicked: ((tag: string) => void) | null = null;

/** What a click on a notice opens. Set once, by the app. */
export function onNotificationClick(open: (tag: string) => void): void {
  clicked = open;
  switch (shell()) {
    case "tauri":
      void listen<{ tag: string | null }>("notification-opened", (event) => {
        if (event.payload.tag) open(event.payload.tag);
      }).catch(() => undefined);
      return;
    case "capacitor":
      void localNotifications()
        .then(({ LocalNotifications: api }) =>
          api.addListener("localNotificationActionPerformed", (action) => {
            const tag = (action.notification.extra as { tag?: string } | undefined)?.tag;
            if (tag) open(tag);
          }),
        )
        .catch(() => undefined);
      return;
    default:
      // A browser notice carries its own click handler, set in `notify`.
      return;
  }
}
