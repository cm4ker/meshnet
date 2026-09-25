/**
 * What the reader wants to hear about: which messages and which new nodes
 * become notices. Settings of this device, not of the radio, so a phone and
 * a computer on the same radio may differ.
 *
 * - Direct messages: on or off.
 * - Channels and rooms: every message, only the ones that mention this
 *   radio (`@[name]`), or none.
 * - New nodes: only a person's radio, any node, or none.
 * - A chat may have a level of its own, which wins over the one for its kind.
 * - Who draws them: the system, or the app itself, Telegram's way. The app
 *   can only draw while it runs: a computer's app does in the tray, a phone's
 *   and a tab's only while on screen, and the system draws the rest.
 *
 * The rules are pure, so they are testable without storage or a radio.
 */

import { useSyncExternalStore } from "react";
import { AdvType, type MessageRecord, type SessionState } from "@meshnet/meshcore";
import { t, type Key } from "../i18n/index.js";
import { readSetting, writeSetting } from "./storage.js";

/** How much of a chat rings: a person's chat takes "all" or "off" only. */
export type ChatLevel = "all" | "mentions" | "off";
export type NodeLevel = "people" | "all" | "off";
/** Who draws a notice: the system's notification centre, or the app's own card. */
export type ShownBy = "system" | "app";
/** Where on a computer's screen the app's own cards stack. */
export type Corner = "br" | "bl" | "tr" | "tl";
/** The app's signal (`public/sounds/signal_<id>.wav`, drawn by `scripts/sound-synth.mjs`), or none. */
export type Signal = "chirp" | "roger" | "hop" | "sonar" | "none";

/** Each signal's name and what it sounds like, as keys: the view says them in the reader's language. */
export const SIGNALS: { id: Signal; label: Key; hint: Key }[] = [
  { id: "chirp", label: "radio.signals.chirp", hint: "radio.signals.chirpHint" },
  { id: "roger", label: "radio.signals.roger", hint: "radio.signals.rogerHint" },
  { id: "hop", label: "radio.signals.hop", hint: "radio.signals.hopHint" },
  { id: "sonar", label: "radio.signals.sonar", hint: "radio.signals.sonarHint" },
  { id: "none", label: "radio.signals.none", hint: "radio.signals.noneHint" },
];

export interface NoticePrefs {
  direct: boolean;
  chats: ChatLevel;
  nodes: NodeLevel;
  /** Chats with a level of their own, by conversation. */
  chat: Record<string, ChatLevel>;
  shownBy: ShownBy;
  corner: Corner;
  /** The sound of every notice, on every shell; the system still decides when to be quiet. */
  signal: Signal;
}

export const DEFAULT_PREFS: NoticePrefs = { direct: true, chats: "all", nodes: "people", chat: {}, shownBy: "system", corner: "br", signal: "chirp" };

const KEY = "meshnet.notices";
/** The two switches before there were levels; off stays off. */
const OLD_MESSAGES = "meshnet.notify";
const OLD_NODES = "meshnet.notify.nodes";

function load(): NoticePrefs {
  const stored = readSetting<Partial<NoticePrefs> | null>(KEY, null);
  if (stored) return { ...DEFAULT_PREFS, ...stored, chat: { ...stored.chat } };
  const messages = readSetting<boolean>(OLD_MESSAGES, true);
  const nodes = readSetting<boolean>(OLD_NODES, true);
  return { ...DEFAULT_PREFS, direct: messages, chats: messages ? "all" : "off", nodes: nodes ? DEFAULT_PREFS.nodes : "off" };
}

let prefs = load();
const listeners = new Set<() => void>();

export function getNoticePrefs(): NoticePrefs {
  return prefs;
}

export function setNoticePrefs(patch: Partial<NoticePrefs>): void {
  prefs = { ...prefs, ...patch };
  writeSetting(KEY, prefs);
  for (const listener of listeners) listener();
}

/** Gives a chat a level of its own, or, with null, back to the one for its kind. */
export function setChatLevel(conversation: string, level: ChatLevel | null): void {
  const chat = { ...prefs.chat };
  if (level) chat[conversation] = level;
  else delete chat[conversation];
  setNoticePrefs({ chat });
}

export function subscribeNoticePrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useNoticePrefs(): NoticePrefs {
  return useSyncExternalStore(subscribeNoticePrefs, getNoticePrefs);
}

/** Whether a conversation is with a person (or a sender not yet in the contacts), rather than a channel or a room. */
export function isDirect(state: SessionState, conversation: string): boolean {
  if (conversation.startsWith("ch:")) return false;
  if (!conversation.startsWith("c:")) return true;
  return state.contacts[conversation.slice(2)]?.type !== AdvType.Room;
}

/** The level its kind gives a conversation, before any of its own. */
export function kindLevel(p: NoticePrefs, direct: boolean): ChatLevel {
  return direct ? (p.direct ? "all" : "off") : p.chats;
}

export function chatLevel(p: NoticePrefs, state: SessionState, conversation: string): ChatLevel {
  return p.chat[conversation] ?? kindLevel(p, isDirect(state, conversation));
}

export function mentionsMe(state: SessionState, message: MessageRecord): boolean {
  const me = state.self?.name;
  return !!me && message.text.includes(`@[${me}]`);
}

/** Whether a message the radio handed over should ring. */
export function messageWanted(p: NoticePrefs, state: SessionState, message: MessageRecord): boolean {
  const level = chatLevel(p, state, message.conversation);
  return level === "all" || (level === "mentions" && mentionsMe(state, message));
}

/** Whether a node heard for the first time should ring, by its advert type. */
export function nodeWanted(p: NoticePrefs, type: number): boolean {
  return p.nodes === "all" || (p.nodes === "people" && type === AdvType.Chat);
}

/** Whether any message at all may ring: a chat of its own may, with the rest off. */
export function anyMessageWanted(p: NoticePrefs): boolean {
  return p.direct || p.chats !== "off" || Object.values(p.chat).some((l) => l !== "off");
}

/** One word for the Radio screen's row. */
export function summaryOf(p: NoticePrefs): string {
  if (!anyMessageWanted(p) && p.nodes === "off") return t("common.off");
  if (p.direct && p.chats === "all" && p.nodes !== "off") return t("common.on");
  if (p.direct && p.chats === "mentions") return t("radio.notifications.mentions");
  return t("radio.notifications.custom");
}
