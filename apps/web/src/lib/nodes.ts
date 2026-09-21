/**
 * What the Nodes section knows about repeaters, rooms and sensors that the
 * session does not: which screens each kind has, which of their settings the
 * console can read and write, and how. Pure, so it is testable without a
 * radio. The console keys are the firmware's (`src/helpers/CommonCLI.cpp`).
 */

import { AclRole, AdvType, contactHops, isNodeType, type ContactRecord, type NodeLogin, type SessionState } from "@meshnet/meshcore";

export type NodeTab = "overview" | "neighbours" | "history" | "settings" | "access" | "console";

export const TAB_LABELS: Record<NodeTab, string> = {
  overview: "Overview",
  neighbours: "Neighbours",
  history: "History",
  settings: "Settings",
  access: "Access",
  console: "Console",
};

/** Only a repeater tracks neighbours; only a sensor keeps series to summarise. */
export function nodeTabs(type: number): NodeTab[] {
  if (type === AdvType.Repeater) return ["overview", "neighbours", "settings", "access", "console"];
  if (type === AdvType.Room) return ["overview", "settings", "access", "console"];
  return ["overview", "history", "settings", "access", "console"];
}

/** A node answers these to admins only. */
export const ADMIN_TABS: ReadonlySet<NodeTab> = new Set<NodeTab>(["settings", "access", "console"]);

/** A legacy "OK" sign-in names no role; it came from firmware that let only admins in. */
export function isAdmin(login: NodeLogin | undefined): boolean {
  return !!login?.ok && (login.role === null || login.role === AclRole.Admin);
}

export function hopsLabel(contact: ContactRecord): string {
  const hops = contactHops(contact);
  return hops === null ? "no route" : hops === 0 ? "direct" : `${hops} hop${hops === 1 ? "" : "s"}`;
}

export function nodeKindName(type: number): string {
  return type === AdvType.Repeater ? "Repeater" : type === AdvType.Room ? "Room" : type === AdvType.Sensor ? "Sensor" : "Node";
}

/** The nodes in the list: every repeater, room and sensor signed in to, asked for its status, or with a password saved. */
export function managedNodes(state: SessionState, saved: readonly string[]): ContactRecord[] {
  return Object.values(state.contacts)
    .filter((c) => isNodeType(c.type) && (state.logins[c.key] !== undefined || state.statusHistory[c.key] !== undefined || saved.includes(c.key)))
    .sort((a, b) => (a.name || a.prefix).localeCompare(b.name || b.prefix));
}

/** Repeaters, rooms and sensors in the contacts that are not in the list yet. */
export function addableNodes(state: SessionState, saved: readonly string[]): ContactRecord[] {
  const managed = new Set(managedNodes(state, saved).map((c) => c.key));
  return Object.values(state.contacts)
    .filter((c) => isNodeType(c.type) && !managed.has(c.key))
    .sort((a, b) => (a.name || a.prefix).localeCompare(b.name || b.prefix));
}

/**
 * How far the node's clock was behind ours when we signed in, seconds;
 * negative when it ran ahead. Null without a clock in the sign-in reply.
 */
export function clockDrift(login: NodeLogin | undefined): number | null {
  if (!login?.ok || login.serverTime === null) return null;
  return Math.round(login.at / 1000 - login.serverTime);
}

// ---- settings ----

export type FieldKind = "text" | "number" | "select" | "toggle" | "textarea";

export interface SettingField {
  /** The console key, and the name the value is remembered under. */
  name: string;
  label: string;
  kind: FieldKind;
  options?: string[];
  hint?: string;
  /** Inclusive bounds for a number; `allowZero` lets 0 through below `min`. */
  min?: number;
  max?: number;
  allowZero?: boolean;
}

export type GroupId = "identity" | "radio" | "repeating" | "access" | "power";

export interface SettingGroup {
  id: GroupId;
  title: string;
  fields: SettingField[];
}

export const RADIO_FIELDS: SettingField[] = [
  { name: "freq", label: "Frequency, MHz", kind: "text" },
  { name: "bw", label: "Bandwidth, kHz", kind: "select", options: ["7.8", "10.4", "15.6", "20.8", "31.25", "41.7", "62.5", "125", "250", "500"] },
  { name: "sf", label: "Spreading factor", kind: "select", options: ["5", "6", "7", "8", "9", "10", "11", "12"] },
  { name: "cr", label: "Coding rate", kind: "select", options: ["5", "6", "7", "8"] },
];

const GROUPS: Record<GroupId, SettingGroup> = {
  identity: {
    id: "identity",
    title: "Identity",
    fields: [
      { name: "name", label: "Name", kind: "text" },
      { name: "lat", label: "Latitude", kind: "text" },
      { name: "lon", label: "Longitude", kind: "text" },
      { name: "owner.info", label: "Owner info", kind: "textarea", hint: "Shown to anyone who asks the node who runs it." },
    ],
  },
  radio: {
    id: "radio",
    title: "Radio",
    // Frequency, bandwidth, SF and CR travel as one `radio` value; see RADIO_FIELDS.
    fields: [{ name: "tx", label: "TX power, dBm", kind: "number", min: -9, max: 30 }],
  },
  repeating: {
    id: "repeating",
    title: "Repeating",
    fields: [
      { name: "repeat", label: "Repeat packets", kind: "toggle", hint: "Off turns the repeater into a listener." },
      { name: "flood.max", label: "Flood max hops", kind: "number", min: 0, max: 64 },
      { name: "advert.interval", label: "Zero-hop advert, min", kind: "number", min: 60, max: 240, allowZero: true, hint: "0 is off, else 60 to 240." },
      { name: "flood.advert.interval", label: "Flood advert, hours", kind: "number", min: 0, max: 168, hint: "0 is off." },
      { name: "txdelay", label: "TX delay factor", kind: "text" },
      { name: "direct.txdelay", label: "Direct TX delay factor", kind: "text" },
      { name: "rxdelay", label: "RX delay base", kind: "text" },
      { name: "af", label: "Airtime factor", kind: "text" },
    ],
  },
  access: {
    id: "access",
    title: "Guests",
    fields: [
      { name: "guest.password", label: "Guest password", kind: "text" },
      { name: "allow.read.only", label: "Let strangers read", kind: "toggle", hint: "A blank password signs in read-only." },
    ],
  },
  power: {
    id: "power",
    title: "Power",
    fields: [{ name: "powersaving", label: "Power saving", kind: "toggle", hint: "Sleeps between packets. Not every board has it." }],
  },
};

/** A sensor has no guests; a room does not repeat. */
export function settingGroups(type: number): SettingGroup[] {
  const ids: GroupId[] =
    type === AdvType.Repeater
      ? ["identity", "radio", "repeating", "access", "power"]
      : type === AdvType.Room
        ? ["identity", "radio", "access", "power"]
        : ["identity", "radio", "power"];
  return ids.map((id) => GROUPS[id]);
}

/** The names a group reads from the node: the radio group reads `radio` whole. */
export function groupReads(group: SettingGroup): string[] {
  return group.id === "radio" ? ["radio", ...group.fields.map((f) => f.name)] : group.fields.map((f) => f.name);
}

export function readCommand(name: string): string {
  return name === "powersaving" ? "powersaving" : `get ${name}`;
}

/** The node writes owner info with `|` for each line break, both ways. */
export function writeCommand(name: string, value: string): string {
  if (name === "powersaving") return `powersaving ${value}`;
  if (name === "owner.info") return `set owner.info ${value.replace(/\r?\n/g, "|")}`;
  return `set ${name} ${value}`;
}

export function displayValue(name: string, value: string): string {
  return name === "owner.info" ? value.replace(/\|/g, "\n") : value;
}

export function storedValue(name: string, value: string): string {
  return name === "owner.info" ? value.replace(/\r?\n/g, "|") : value;
}

export interface RadioValue {
  freq: string;
  bw: string;
  sf: string;
  cr: string;
}

/** `869.618,62.500,8,8`, as `get radio` answers it. */
export function parseRadio(value: string | undefined): RadioValue | null {
  if (!value) return null;
  const parts = value.split(",").map((p) => p.trim());
  if (parts.length !== 4) return null;
  const [freq, bw, sf, cr] = parts as [string, string, string, string];
  return { freq: trimNumber(freq), bw: trimNumber(bw), sf, cr };
}

export function formatRadio(radio: RadioValue): string {
  return `${radio.freq},${radio.bw},${radio.sf},${radio.cr}`;
}

function trimNumber(text: string): string {
  const n = Number(text);
  return Number.isFinite(n) ? String(n) : text;
}

/** What is wrong with a value before it goes on the air, or null. */
export function validate(field: SettingField, value: string): string | null {
  if (field.kind === "number") {
    if (!/^-?\d+$/.test(value.trim())) return "A whole number.";
    const n = Number(value);
    if (field.allowZero && n === 0) return null;
    if (field.min !== undefined && n < field.min) return `At least ${field.min}.`;
    if (field.max !== undefined && n > field.max) return `At most ${field.max}.`;
  }
  if ((field.name === "lat" || field.name === "lon") && !Number.isFinite(Number(value))) return "Degrees, like 59.93421.";
  if (field.name === "name" && !value.trim()) return "A name is needed.";
  if (new TextEncoder().encode(writeCommand(field.name, value)).length > 150) return "Too long for one console command.";
  return null;
}

export function validateRadio(radio: RadioValue): string | null {
  const freq = Number(radio.freq);
  if (!Number.isFinite(freq) || freq < 150 || freq > 2500) return "Frequency between 150 and 2500 MHz.";
  return null;
}
