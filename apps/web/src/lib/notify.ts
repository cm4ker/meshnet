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
import { anyMessageWanted, getNoticePrefs, subscribeNoticePrefs } from "./noticePrefs.js";
import { nativePlatform, shell } from "./platform.js";

/** What a notice is about, which on Android is its channel: the reader sets each one's sound in the system. */
export type NoticeKind = "direct" | "chats" | "nodes";

const CHANNELS: { id: NoticeKind; name: string; description: string }[] = [
  { id: "direct", name: "Direct messages", description: "A message from a person to you." },
  { id: "chats", name: "Channels and rooms", description: "Messages in channels and rooms, or only the ones that mention you." },
  { id: "nodes", name: "New nodes", description: "A node heard for the first time." },
];

/**
 * The iPhone's native watch (`MeshWatch.swift`): it announces what the radio
 * pushes while the page is asleep in the background, as a stand-in that waits
 * a few seconds for the page to announce the same thing itself.
 */
interface MeshWatchPlugin {
  /** `people`: only a person's radio is a new node worth a notice. */
  configure(options: { messages: boolean; nodes: boolean; people: boolean }): Promise<void>;
  /** The page has announced this tag itself, so the watch withdraws its own notice for it. */
  announced(options: { tag: string }): Promise<void>;
  /** The radio the page is connected to, by the BLE plugin's device id; none without one. */
  follow(options: { deviceId?: string }): Promise<void>;
  /** Opens the system's notification settings for the app. */
  openSettings(): Promise<void>;
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

/**
 * Hands the settings to the watch, which cannot read the page's storage. It
 * cannot tell one message from another either, only that one is waiting: it
 * announces them all while any message may ring.
 */
export async function tellWatch(): Promise<void> {
  const prefs = getNoticePrefs();
  try {
    await withWatch((w) => w.configure({ messages: anyMessageWanted(prefs), nodes: prefs.nodes !== "off", people: prefs.nodes === "people" }));
  } catch (error) {
    console.warn("Could not configure iOS background notifications", error);
  }
}

subscribeNoticePrefs(() => void tellWatch());

let followed: string | null = null;

/**
 * Points the watch at the radio the page has just connected to, or at none.
 * The watch listens to that one only: the phone may hold links to other
 * radios, and subscribing to one it is not paired with makes iOS ask for
 * that radio's PIN.
 */
export async function watchRadio(deviceId: string | null): Promise<void> {
  followed = deviceId;
  try {
    await withWatch((w) => w.follow(deviceId ? { deviceId } : {}));
  } catch (error) {
    console.warn("Could not point iOS background notifications at the radio", error);
  }
}

/** The page let go of this radio: so does the watch, unless it already follows another. */
export async function unwatchRadio(deviceId: string): Promise<void> {
  if (followed === deviceId) await watchRadio(null);
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
  const prefs = getNoticePrefs();
  if (!anyMessageWanted(prefs) && prefs.nodes === "off") return;
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

let channels: Promise<void> | null = null;

/** Android's channels, one per kind of notice, made once; making one that exists changes nothing. */
function androidChannels(api: LocalNotificationsModule["LocalNotifications"]): Promise<void> {
  channels ??= Promise.all(CHANNELS.map((c) => api.createChannel({ ...c, importance: 4, visibility: 0 })))
    .then(() => undefined)
    .catch((error) => {
      channels = null;
      console.warn("Could not create notification channels", error);
    });
  return channels;
}

/** Whether this shell can open the system's notification settings for the app. */
export function hasNoticeSettings(): boolean {
  return shell() === "capacitor" || (shell() === "tauri" && navigator.userAgent.includes("Windows"));
}

interface NoticesPlugin {
  openSettings(): Promise<void>;
}
let notices: NoticesPlugin | null = null;

/** Sound, vibration and quiet hours are the system's: this opens its page for the app. */
export async function openNoticeSettings(): Promise<void> {
  if (shell() === "tauri") {
    await invoke("plugin:opener|open_url", { url: "ms-settings:notifications" });
    return;
  }
  if (shell() !== "capacitor") return;
  if (nativePlatform() === "ios") return withWatch((w) => w.openSettings());
  const { registerPlugin } = await import("@capacitor/core");
  notices ??= registerPlugin<NoticesPlugin>("Notices");
  await notices.openSettings();
}

/** The caller checks preferences and whether what it announces is already on screen. */
export async function notify(title: string, body: string, tag: string, kind: NoticeKind): Promise<void> {
  switch (shell()) {
    case "tauri":
      await invoke("announce", { title, body, tag }).catch(() => undefined);
      return;
    case "capacitor":
      try {
        const { LocalNotifications: api } = await localNotifications();
        const android = nativePlatform() === "android";
        if (android) await androidChannels(api);
        await api.schedule({ notifications: [{
          id: noticeId(tag), title, body, extra: { tag },
          ...(android ? { channelId: kind } : {}),
          // Without a sound iOS delivers silently. A missing named sound
          // uses the system default; Android already supplies its own.
          ...(nativePlatform() === "ios" ? { sound: "default", foreground: true } : {}),
          // The notice is shown now, not at a time. Left exact, the plugin opens Android's
          // "Alarms & reminders" settings over the app for every notice until that is granted.
          isExactNotification: false,
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
