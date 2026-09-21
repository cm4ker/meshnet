/**
 * System notifications, for a message that arrives or a node heard for the
 * first time while the window is not in front. Each shell draws them its own
 * way:
 *
 * - a browser tab, with the Web Notification API;
 * - the desktop shell, natively (`announce.rs`), since WebView2 draws none;
 * - the phone app, with Capacitor's local notifications, since neither
 *   WKWebView nor Android's WebView has a `Notification` at all.
 *
 * Each notice carries a tag saying what it is about, `c:<conversation>` or
 * `n:<contact key>`, and a click on it hands the tag back to open that.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { shell } from "./platform.js";
import { readSetting, writeSetting } from "./storage.js";

const MESSAGES_KEY = "meshnet.notify";
const NODES_KEY = "meshnet.notify.nodes";

export function notificationsWanted(): boolean {
  return readSetting<boolean>(MESSAGES_KEY, true);
}

export function setNotificationsWanted(on: boolean): void {
  writeSetting(MESSAGES_KEY, on);
}

export function nodeNotificationsWanted(): boolean {
  return readSetting<boolean>(NODES_KEY, true);
}

export function setNodeNotificationsWanted(on: boolean): void {
  writeSetting(NODES_KEY, on);
}

type LocalNotificationsModule = typeof import("@capacitor/local-notifications");

let local: Promise<LocalNotificationsModule["LocalNotifications"]> | null = null;
function localNotifications(): Promise<LocalNotificationsModule["LocalNotifications"]> {
  local ??= import("@capacitor/local-notifications").then((m) => m.LocalNotifications);
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
      const api = await localNotifications();
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

function inFront(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

let nextId = Math.floor(Date.now() / 1000) % 1_000_000_000;

/** Shows a notice unless the window is in front. The caller checks which kind the reader wants. */
export function notify(title: string, body: string, tag: string): void {
  if (inFront()) return;
  switch (shell()) {
    case "tauri":
      void invoke("announce", { title, body, tag }).catch(() => undefined);
      return;
    case "capacitor":
      void localNotifications()
        .then((api) => api.schedule({ notifications: [{ id: ++nextId, title, body, extra: { tag } }] }))
        .catch(() => undefined);
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
      } catch {
        // Some webviews throw on construction; there is nothing to do about it.
      }
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
        .then((api) =>
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
