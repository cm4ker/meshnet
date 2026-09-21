/**
 * A system notification for a message that arrives while the window is not
 * in front. The Web Notification API is what every shell has: WebView2 and
 * WKWebView both route it to the system.
 */

import { readSetting, writeSetting } from "./storage.js";

const KEY = "meshnet.notify";

export function notificationsWanted(): boolean {
  return readSetting<boolean>(KEY, true);
}

export function setNotificationsWanted(on: boolean): void {
  writeSetting(KEY, on);
}

export async function askPermission(): Promise<boolean> {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  return (await Notification.requestPermission()) === "granted";
}

export function notify(title: string, body: string, tag: string): void {
  if (!notificationsWanted()) return;
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    new Notification(title, { body, tag });
  } catch {
    // Some webviews throw on construction; there is nothing to do about it.
  }
}
