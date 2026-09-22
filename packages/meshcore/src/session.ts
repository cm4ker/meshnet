/**
 * The state of a radio and everything heard through it, kept in one immutable
 * snapshot the UI subscribes to: contacts, channels, conversations, what the
 * radio said about itself, and what the last push was.
 *
 * The radio holds contacts and channels and a short queue of unread messages;
 * it does not keep history. So the session does, through a `SessionStorage`
 * the shell supplies, keyed by the radio's public key so two radios on one
 * phone do not mix.
 */

import { MeshCoreClient, MeshCoreError, TimeoutError, type TextSendResult } from "./client.js";
import { bytesEqual, fromHex, pathByteLength, toHex, unixNow } from "./protocol/bytes.js";
import { groupTextPayload, heardGroupTextPayload } from "./protocol/group.js";
import { PayloadType, parseRawPacket, type RawPacket } from "./protocol/packet.js";
import { AclRole, AdvType, ContactFlag, ControlType, MAX_TEXT_LEN, PUB_KEY_PREFIX_SIZE, StatsType, TxtType } from "./protocol/codes.js";
import {
  accessListRequest,
  avgMinMaxRequest,
  neighboursRequest,
  nodeDiscoverRequest,
  ownerInfoRequest,
  type OtherParams,
  type RadioParams,
} from "./protocol/commands.js";
import {
  readAccessList,
  readAvgMinMax,
  readNeighbours,
  readNodeStats,
  readOwnerInfo,
  type Contact,
  type DeviceInfo,
  type NodeStats,
  type PushFrame,
  type SelfInfo,
  type SeriesSummary,
} from "./protocol/frames.js";
import type { LppReading } from "./protocol/lpp.js";
import type { Transport } from "./transport.js";

export interface ContactRecord {
  /** Hex of the 32-byte key; the identity everywhere in this app. */
  key: string;
  /** Hex of the first six bytes, which is how messages name their sender. */
  prefix: string;
  type: number;
  flags: number;
  outPathLen: number;
  outPath: string;
  name: string;
  lastAdvert: number;
  lat: number;
  lon: number;
  lastMod: number;
  /** Local clock, ms: the last time the radio heard from this contact while we were listening. */
  lastHeardAt: number | null;
  /**
   * Local clock, ms: when the radio learned the route it holds, so it can be
   * dropped once stale. `lastMod` cannot say: adverts and messages move it too.
   * Null while there is no route.
   */
  pathSince: number | null;
}

export interface ChannelRecord {
  index: number;
  name: string;
  /** Hex of the 16-byte secret. */
  secret: string;
}

/** `queued`: written while the radio was away; it goes out, in order, once the radio is back. */
export type MessageStatus = "queued" | "sending" | "sent" | "delivered" | "unconfirmed" | "failed";

/**
 * A copy of a message the radio heard: for one of ours on a channel, a repeater
 * sending it on; for one that came in, each copy that reached us.
 */
export interface MessageEcho {
  /** The relays it had passed, first relay first, each as the hex hash it signs the path with. */
  path: string[];
  snr: number;
}

export interface MessageRecord {
  id: string;
  /** `c:<key>` for a contact, `ch:<index>` for a channel, `p:<prefix>` for a sender the radio did not name. */
  conversation: string;
  direction: "in" | "out";
  text: string;
  /** On a channel: the name before the colon. On a DM: the contact's name at the time. */
  sender: string | null;
  senderPrefix: string | null;
  /** Unix seconds, the sender's clock. */
  timestamp: number;
  /** Local clock, ms. */
  receivedAt: number;
  snr: number | null;
  hops: number | null;
  txtType: number;
  status: MessageStatus | null;
  ackTag: number | null;
  roundTripMs: number | null;
  flood: boolean | null;
  attempt: number;
  error: string | null;
  /**
   * Copies the radio heard, one per distinct path. For ours on a channel, the
   * repeaters sending it on; for an incoming flood, every copy that reached us,
   * the one delivered first. Empty when the radio heard none while we listened.
   */
  echoes: MessageEcho[];
  /**
   * Our direct message: the relays it went along, as hex hashes, first relay
   * first. A flood has none until its acknowledgement brings back the route it
   * took. Empty for a neighbour heard direct; null when not known.
   */
  route: string[] | null;
  /** What was typed, when the text sent was reworked to fit (lookalike letters packed). */
  original?: string;
}

/** How direct messages to one contact are routed; unset fields follow the defaults. */
export interface RoutePolicy {
  /** Every message floods: the learned route is dropped before each send, and whenever the radio learns one. */
  flood?: boolean;
  /** Minutes a learned route is kept before it is dropped; null keeps it. Absent follows `RoutingSettings.resetAfterMin`. */
  resetAfterMin?: number | null;
  /**
   * The route last written by hand, as `routeKey` gives it. While the radio
   * still holds that route it is not dropped for its age; the radio replaces
   * it as soon as it learns another.
   */
  manual?: string;
}

export interface RoutingSettings {
  /** Minutes a route to a chat or a room is kept after the radio learned it; null keeps it until the radio replaces it. */
  resetAfterMin: number | null;
  contacts: Record<string, RoutePolicy>;
}

export interface LogEntry {
  at: number;
  kind: string;
  text: string;
}

/** What a repeater, room or sensor said the last time we signed in to it. */
export interface NodeLogin {
  ok: boolean;
  /** An `AclRole`, when the node said; a legacy "OK" does not. */
  role: number | null;
  /** The node's clock at sign-in, unix seconds. */
  serverTime: number | null;
  firmwareLevel: number | null;
  /** Local clock, ms. */
  at: number;
}

export interface NodeStatus {
  stats: NodeStats | null;
  /** Hex of the body, for a shape this client does not read. */
  raw: string;
  at: number;
}

/** One status answer, kept for the trend lines. */
export interface StatusSample {
  at: number;
  batteryMv: number;
  noiseFloor: number;
}

export interface NeighbourRecord {
  /** Hex of the six-byte key prefix. */
  prefix: string;
  heardSecsAgo: number;
  snr: number;
}

export interface NeighbourList {
  /** How many the node knows, of which `neighbours` is the part fetched so far. */
  total: number;
  /** A `NeighbourOrder`. */
  order: number;
  neighbours: NeighbourRecord[];
  at: number;
}

export interface AccessRecord {
  prefix: string;
  permissions: number;
}

export interface OwnerInfo {
  firmware: string;
  name: string;
  owner: string;
  at: number;
}

export interface SeriesWindow {
  /** How far back the window reaches, seconds. */
  windowSecs: number;
  /** The sensor's clock when it answered. */
  time: number;
  series: SeriesSummary[];
  at: number;
}

export type ConsoleStatus = "queued" | "waiting" | "done" | "timeout" | "failed";

/** A console command and what came back, or a line the node sent unasked. */
export interface ConsoleEntry {
  id: string;
  /** Empty for a line nobody here asked for. */
  command: string;
  /** The two characters before `|` the node echoes back. */
  tag: string;
  at: number;
  status: ConsoleStatus;
  reply: string | null;
  repliedAt: number | null;
  error: string | null;
}

/** A value read from a node with `get`, or confirmed by a `set`. */
export interface NodeSetting {
  value: string;
  at: number;
}

/** A request to a remote node, waiting its turn or on the air. */
export interface RemoteJobInfo {
  id: string;
  key: string;
  label: string;
  /** Local ms when it went out; null while queued. */
  startedAt: number | null;
}

export interface SessionState {
  status: "idle" | "connecting" | "ready" | "closed";
  link: { kind: Transport["kind"]; label: string } | null;
  device: DeviceInfo | null;
  self: (Omit<SelfInfo, "publicKey"> & { key: string; prefix: string }) | null;
  contacts: Record<string, ContactRecord>;
  /** The `lastMod` cursor the next incremental contact fetch starts from. */
  contactsCursor: number;
  channels: ChannelRecord[];
  messages: MessageRecord[];
  unread: Record<string, number>;
  battery: { mv: number; at: number } | null;
  tuning: { rxDelayBase: number; airtimeFactor: number } | null;
  /** Keyed by contact key, like everything about remote nodes below. */
  logins: Record<string, NodeLogin>;
  telemetry: Record<string, { readings: LppReading[]; at: number }>;
  statuses: Record<string, NodeStatus>;
  /** A week of status answers per node, oldest first. */
  statusHistory: Record<string, StatusSample[]>;
  neighbours: Record<string, NeighbourList>;
  accessLists: Record<string, { entries: AccessRecord[]; at: number }>;
  ownerInfo: Record<string, OwnerInfo>;
  series: Record<string, SeriesWindow>;
  nodeSettings: Record<string, Record<string, NodeSetting>>;
  consoles: Record<string, ConsoleEntry[]>;
  /** The radio carries one request to a remote node at a time; the rest wait here. */
  remote: { active: RemoteJobInfo | null; queued: RemoteJobInfo[] };
  /** How direct messages are routed: a flood pinned per contact, and how long a learned route is trusted. */
  routing: RoutingSettings;
  /** The most recent pushes and errors, newest last, for a log pane. */
  log: LogEntry[];
  error: string | null;
  syncing: boolean;
}

/** What survives a disconnect, per radio. */
export interface PersistedState {
  contacts: Record<string, ContactRecord>;
  contactsCursor: number;
  channels: ChannelRecord[];
  messages: MessageRecord[];
  unread: Record<string, number>;
  /** Absent in history saved before remote nodes were managed. */
  logins?: Record<string, NodeLogin>;
  statusHistory?: Record<string, StatusSample[]>;
  /** Absent in history saved before routes could be pinned or timed out. */
  routing?: RoutingSettings;
}

export interface SessionStorage {
  load(radioKey: string): Promise<PersistedState | null>;
  save(radioKey: string, state: PersistedState): Promise<void>;
}

export interface SessionOptions {
  appName?: string;
  storage?: SessionStorage;
  /** Overrides the clock, for tests. Returns ms. */
  now?: () => number;
  /** How long to wait for a remote node, from the radio's estimate; for tests. */
  replyWaitMs?: (estimateMs: number, extraMs: number) => number;
  trace?: ConstructorParameters<typeof MeshCoreClient>[1] extends infer O ? (O extends { trace?: infer T } ? T : never) : never;
  /** How long to wait for a trace to come back, from the radio's estimate; for tests. */
  traceWaitMs?: (estimateMs: number) => number;
}

/** One trace that came back. */
export interface TraceResult {
  /** From the radio saying it sent the trace to the trace coming back, ms. */
  rttMs: number;
  /** The SNR at each node along the path, out and back, then ours of the last hop, dB. */
  snrs: number[];
}

/** A node in direct range that answered "who hears me". */
export interface DiscoverReply {
  /** Its whole key; only the hex it sent, when it sent a prefix. */
  key: string;
  /** Whether it is among the contacts. */
  known: boolean;
  /** Its `AdvType`. */
  type: number;
  /** How well it heard this radio, dB. */
  heardUs: number;
  /** How well this radio heard its answer, dB. */
  heardThem: number;
  rssi: number;
  /** Local clock, ms. */
  at: number;
}

/** What the radio says about its own receiver. */
export interface RadioStats {
  /** dBm. */
  noiseFloor: number;
  lastRssi: number;
  lastSnr: number;
  /** Seconds on the air since it booted, sending and receiving. */
  txAirSecs: number;
  rxAirSecs: number;
  /** Local clock, ms. */
  at: number;
}

/** A packet the radio received, whoever it was for. */
export interface HeardPacket {
  /** Local clock, ms. */
  at: number;
  snr: number;
  rssi: number;
  /** The whole packet as it was on the air, bytes. */
  size: number;
  /** Null when the bytes are not a packet. */
  packet: RawPacket | null;
}

export function contactConversation(key: string): string {
  return `c:${key}`;
}

export function channelConversation(index: number): string {
  return `ch:${index}`;
}

export function parseConversation(id: string): { kind: "contact"; key: string } | { kind: "channel"; index: number } | { kind: "prefix"; prefix: string } {
  if (id.startsWith("c:")) return { kind: "contact", key: id.slice(2) };
  if (id.startsWith("ch:")) return { kind: "channel", index: Number(id.slice(3)) };
  if (id.startsWith("p:")) return { kind: "prefix", prefix: id.slice(2) };
  throw new Error(`not a conversation id: ${id}`);
}

/** `<sender>: <text>`, as the firmware writes a channel message. */
export function splitChannelText(text: string): { sender: string | null; text: string } {
  const at = text.indexOf(": ");
  if (at <= 0) return { sender: null, text };
  return { sender: text.slice(0, at), text: text.slice(at + 2) };
}

export function isFavourite(contact: ContactRecord): boolean {
  return (contact.flags & ContactFlag.Favourite) !== 0;
}

export function contactHops(contact: ContactRecord): number | null {
  return contact.outPathLen === 0xff ? null : contact.outPathLen & 63;
}

/** The hashes of a path as the firmware writes one: the low six bits of `pathLen` count them, the top two size them. */
export function pathHashes(pathLen: number, path: Uint8Array | string): string[] {
  const hex = typeof path === "string" ? path : toHex(path);
  const size = ((pathLen >> 6) + 1) * 2;
  const hashes: string[] = [];
  for (let i = 0; i < (pathLen & 63); i++) hashes.push(hex.slice(i * size, (i + 1) * size));
  return hashes;
}

/** A route as one string, so two can be compared: its length byte and the hashes it holds. */
export function routeKey(outPathLen: number, outPath: string): string {
  return outPathLen === 0xff ? "none" : `${outPathLen}:${outPath.slice(0, pathByteLength(outPathLen) * 2)}`;
}

/**
 * A trace that went out through `relays` nodes and came back the same way,
 * leg by leg from this radio outwards: the SNR at the far end of each leg
 * going out, and at the near end coming back.
 */
export function traceLegs(snrs: number[], relays: number): [out: number, back: number][] {
  const legs: [number, number][] = [];
  for (let j = 0; j < relays; j++) {
    const out = snrs[j];
    const back = snrs[2 * relays - 1 - j];
    if (out === undefined || back === undefined) break;
    legs.push([out, back]);
  }
  return legs;
}

function randomU32(): number {
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === "function") return c.getRandomValues(new Uint32Array(1))[0]!;
  return Math.floor(Math.random() * 0x1_0000_0000) >>> 0;
}

/** The relays of the route the radio holds for a contact, as hex hashes, first relay first; null with none. */
export function contactRoute(contact: Pick<ContactRecord, "outPathLen" | "outPath">): string[] | null {
  if (contact.outPathLen === 0xff) return null;
  const count = contact.outPathLen & 63;
  const size = ((contact.outPathLen >> 6) + 1) * 2;
  const hashes: string[] = [];
  for (let i = 0; i < count; i++) hashes.push(contact.outPath.slice(i * size, (i + 1) * size));
  return hashes;
}

/** The contacts one writes to, whose direct messages the routing settings govern: chats and rooms. */
export function isConversationType(type: number): boolean {
  return type === AdvType.Chat || type === AdvType.Room;
}

export function contactTypeName(type: number): string {
  switch (type) {
    case AdvType.Chat:
      return "chat";
    case AdvType.Repeater:
      return "repeater";
    case AdvType.Room:
      return "room";
    case AdvType.Sensor:
      return "sensor";
    default:
      return "unknown";
  }
}

export function isNodeType(type: number): boolean {
  return type === AdvType.Repeater || type === AdvType.Room || type === AdvType.Sensor;
}

export function aclRoleName(role: number): string {
  switch (role & 3) {
    case AclRole.Admin:
      return "admin";
    case AclRole.ReadWrite:
      return "read-write";
    case AclRole.ReadOnly:
      return "read-only";
    default:
      return "guest";
  }
}

/** Nothing came back from a remote node within the time the radio said it would take. */
export class NoReplyError extends Error {
  constructor(label: string, ms: number) {
    super(`${label}: no reply in ${Math.round(ms / 1000)} s`);
    this.name = "NoReplyError";
  }
}

/** A node answered a console command with an error of its own. */
export class NodeCommandError extends Error {
  constructor(readonly reply: string) {
    super(reply);
    this.name = "NodeCommandError";
  }
}

/**
 * Replies that mean the node refused: `Err - bad params`, `Error, …`,
 * `Unknown command`, `unknown config: key`, `??: key`, `Board not supported`.
 */
export function isCliError(reply: string): boolean {
  const text = reply.trim();
  return /^(err\b|error|unknown|\?\?)/i.test(text) || /\bnot supported$/i.test(text);
}

/** The value of a `get` reply, which the node writes as `> value`. */
export function cliValue(reply: string): string | null {
  const trimmed = reply.replace(/\s+$/, "");
  return trimmed.startsWith("> ") ? trimmed.slice(2) : trimmed === ">" ? "" : null;
}

/**
 * When a route the radio learned while nobody was listening came to be: the
 * contact's `lastMod`, if it is a time at all, and now otherwise, so a route
 * of unknown age is not dropped the moment it is seen.
 */
function guessPathSince(lastMod: number, now: number): number {
  const at = lastMod * 1000;
  return at > now - 7 * 24 * 3600 * 1000 && at <= now ? at : now;
}

/**
 * `previous` is what was known of the contact: its route's age carries over
 * while the route is the same. `learnedAt` is set when the radio has just said
 * it learned this route.
 */
function toRecord(contact: Contact, lastHeardAt: number | null, previous: ContactRecord | undefined, now: number, learnedAt?: number): ContactRecord {
  const key = toHex(contact.publicKey);
  const outPath = toHex(contact.outPath);
  let pathSince: number | null = null;
  if (contact.outPathLen !== 0xff) {
    const same = previous !== undefined && previous.outPathLen === contact.outPathLen && previous.outPath === outPath && previous.pathSince !== null;
    pathSince = learnedAt ?? (same ? previous.pathSince : guessPathSince(contact.lastMod, now));
  }
  return {
    key,
    prefix: key.slice(0, PUB_KEY_PREFIX_SIZE * 2),
    type: contact.type,
    flags: contact.flags,
    outPathLen: contact.outPathLen,
    outPath,
    name: contact.name,
    lastAdvert: contact.lastAdvert,
    lat: contact.lat,
    lon: contact.lon,
    lastMod: contact.lastMod,
    lastHeardAt,
    pathSince,
  };
}

const LOG_LIMIT = 400;

let idCounter = 0;
function newId(now: number): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  idCounter += 1;
  return `${now.toString(36)}-${idCounter.toString(36)}`;
}

const EMPTY: SessionState = {
  status: "idle",
  link: null,
  device: null,
  self: null,
  contacts: {},
  contactsCursor: 0,
  channels: [],
  messages: [],
  unread: {},
  battery: null,
  tuning: null,
  logins: {},
  telemetry: {},
  statuses: {},
  statusHistory: {},
  neighbours: {},
  accessLists: {},
  ownerInfo: {},
  series: {},
  nodeSettings: {},
  consoles: {},
  remote: { active: null, queued: [] },
  routing: { resetAfterMin: null, contacts: {} },
  log: [],
  error: null,
  syncing: false,
};

/** How long after sending a channel message its echoes are still looked for. */
const ECHO_WINDOW_MS = 15 * 60 * 1000;

/** How often learned routes are checked against their time limit while connected. */
const ROUTE_SWEEP_MS = 30 * 1000;

/** How long a packet the radio overheard is kept, to find the copies of a message that arrives after it. */
const HEARD_WINDOW_MS = 30 * 1000;
const HEARD_LIMIT = 64;

/** How long after an incoming message later copies of it are still looked for. */
const IN_ECHO_WINDOW_MS = 60 * 1000;

/** How far back a direct message's packet may have been heard before the radio handed the message up. */
const DM_MATCH_MS = 15 * 1000;

/** How far back status answers are kept, and at most how many a node. */
const HISTORY_MS = 7 * 24 * 3600 * 1000;
const HISTORY_LIMIT = 600;

/** The last this many console lines a node are kept. */
const CONSOLE_LIMIT = 200;

/** What a remote node's reply is matched by. */
type RemoteEvent =
  | { kind: "login"; prefix: string; ok: boolean }
  | { kind: "status"; prefix: string }
  | { kind: "telemetry"; prefix: string; readings: LppReading[] }
  | { kind: "binary"; tag: number; data: Uint8Array }
  | { kind: "path"; prefix: string }
  | { kind: "cli"; prefix: string; tag: string | null; text: string };

interface RemoteJob {
  info: RemoteJobInfo;
  /** Sends the command; the radio answers with the tag and how long the reply may take. */
  start: (client: MeshCoreClient) => Promise<TextSendResult>;
  /** Whether this event is the reply, given what the radio said when it sent the request. */
  answers: (event: RemoteEvent, sent: TextSendResult | null) => boolean;
  /** Added to the radio's estimate: a node holds a console reply back before it sends it. */
  extraWaitMs: number;
  sent: TextSendResult | null;
  /** Events that arrived before the radio had confirmed the send. */
  early: RemoteEvent[];
  timer: ReturnType<typeof setTimeout> | null;
  resolve: (event: RemoteEvent) => void;
  reject: (error: Error) => void;
}

/** How long to wait for a remote node: the radio's estimate with room to spare, but not forever. */
function replyWaitMs(estimateMs: number, extraMs: number): number {
  return Math.min(60_000, Math.max(6_000, estimateMs * 1.25 + 1_500 + extraMs));
}

export class MeshSession {
  private state: SessionState = EMPTY;
  private listeners = new Set<() => void>();
  private discoveredListeners = new Set<(contact: ContactRecord) => void>();
  private receivedListeners = new Set<(message: MessageRecord) => void>();
  private client: MeshCoreClient | null = null;
  private readonly appName: string;
  private readonly storage: SessionStorage | null;
  private readonly now: () => number;
  private readonly replyWait: (estimateMs: number, extraMs: number) => number;
  private readonly trace: SessionOptions["trace"];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveChain: Promise<void> = Promise.resolve();
  private syncQueued = false;
  private contactsRefreshQueued = false;
  private focused: string | null = null;
  private ackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** The queue of messages written while the radio was away is being sent. */
  private flushing = false;
  /**
   * What recent messages look like on the air (payload hex), to know their
   * copies by: ours on a channel, and incoming ones whose packet was found.
   */
  private echoWatch = new Map<string, { id: string; at: number; incoming: boolean }>();
  /** Packets the radio overheard lately, newest last; a message's packet is heard before the message is handed up. */
  private heard: { at: number; snr: number; packet: RawPacket; hex: string }[] = [];
  /** Payloads already matched to an incoming direct message, so a second one from the same sender takes the next. */
  private claimed = new Set<string>();
  /** The last route the radio said it learned: the acknowledgement of a flood rides in on it. */
  private lastPathUpdate: { key: string; at: number; record: Promise<ContactRecord | null> } | null = null;
  private routeTimer: ReturnType<typeof setInterval> | null = null;
  /** Contacts whose route is being dropped right now, so the sweep and a send do not both do it. */
  private droppingRoutes = new Set<string>();
  private remoteQueue: RemoteJob[] = [];
  private remoteActive: RemoteJob | null = null;
  private jobCounter = 0;
  /** The next console tag; two hex digits, so the node's `XX|` rule holds. */
  private cliTag = Math.floor(Math.random() * 256);
  /** Traces on the air, by tag, each waiting for its way back. */
  private traceWaiters = new Map<number, (frame: Extract<PushFrame, { kind: "traceData" }>) => void>();
  private controlListeners = new Set<(frame: Extract<PushFrame, { kind: "controlData" }>) => void>();
  private heardListeners = new Set<(packet: HeardPacket) => void>();
  private readonly traceWait: (estimateMs: number) => number;

  constructor(options: SessionOptions = {}) {
    this.appName = options.appName ?? "Meshnet";
    this.storage = options.storage ?? null;
    this.now = options.now ?? (() => Date.now());
    this.replyWait = options.replyWaitMs ?? replyWaitMs;
    this.traceWait = options.traceWaitMs ?? ((estimate) => Math.min(30_000, Math.max(2_500, estimate * 1.2 + 500)));
    this.trace = options.trace;
  }

  // ---- the store ----

  getState(): SessionState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * A node the radio has just heard advertise for the first time: its
   * `NEW_ADVERT` push, which the firmware sends for a key it did not know,
   * whether or not it added the contact. The contacts read at connect are
   * not new and say nothing.
   */
  onDiscovered(listener: (contact: ContactRecord) => void): () => void {
    this.discoveredListeners.add(listener);
    return () => this.discoveredListeners.delete(listener);
  }

  /**
   * A message the radio has just handed over from its queue, once it is in
   * the state. The history read back from the storage at connect was handed
   * over on an earlier run and says nothing.
   */
  onReceived(listener: (message: MessageRecord) => void): () => void {
    this.receivedListeners.add(listener);
    return () => this.receivedListeners.delete(listener);
  }

  /** Every packet the radio receives, as it hands them up; kept out of the state, which would change with each. */
  onHeard(listener: (packet: HeardPacket) => void): () => void {
    this.heardListeners.add(listener);
    return () => this.heardListeners.delete(listener);
  }

  private set(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
    if (
      "contacts" in patch ||
      "contactsCursor" in patch ||
      "channels" in patch ||
      "messages" in patch ||
      "unread" in patch ||
      "logins" in patch ||
      "statusHistory" in patch ||
      "routing" in patch
    ) {
      this.scheduleSave();
    }
  }

  private log(kind: string, text: string): void {
    const entry: LogEntry = { at: this.now(), kind, text };
    const log = this.state.log.length >= LOG_LIMIT ? this.state.log.slice(-LOG_LIMIT + 1) : this.state.log;
    this.set({ log: [...log, entry] });
  }

  private scheduleSave(): void {
    if (!this.storage || !this.state.self) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow();
    }, 400);
  }

  private async saveNow(strict = false): Promise<void> {
    if (!this.storage || !this.state.self) return;
    const storage = this.storage;
    const key = this.state.self.key;
    const { contacts, contactsCursor, channels, messages, unread, logins, statusHistory, routing } = this.state;
    const saving = this.saveChain.catch(() => undefined).then(() => storage.save(key, { contacts, contactsCursor, channels, messages, unread, logins, statusHistory, routing }));
    this.saveChain = saving;
    try {
      await saving;
    } catch (error) {
      this.log("error", `could not save: ${(error as Error).message}`);
      if (strict) throw error;
    }
  }

  /** Wait for the latest history to reach storage before an update exits the app. */
  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    await this.saveNow(true);
  }

  // ---- connecting ----

  get isReady(): boolean {
    return this.state.status === "ready" && this.client !== null;
  }

  get hasPendingCommands(): boolean {
    return this.client?.isBusy ?? false;
  }

  private need(): MeshCoreClient {
    if (!this.client || this.client.isClosed) throw new Error("not connected");
    return this.client;
  }

  async connect(transport: Transport): Promise<void> {
    if (this.client) await this.disconnect();
    // What changed since the link dropped (a message queued meanwhile) is
    // saved before the history is read back from the storage.
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      await this.saveNow();
    }
    const client = new MeshCoreClient(transport, this.trace ? { trace: this.trace } : {});
    this.client = client;
    this.set({
      ...EMPTY,
      status: "connecting",
      link: { kind: transport.kind, label: transport.label },
      log: this.state.log,
    });
    client.onPush((frame) => this.onPush(frame));
    client.onClose((reason) => {
      if (this.client !== client) return;
      this.client = null;
      for (const timer of this.ackTimers.values()) clearTimeout(timer);
      this.ackTimers.clear();
      if (this.routeTimer) clearInterval(this.routeTimer);
      this.routeTimer = null;
      this.dropRemoteJobs(reason ? `link dropped: ${reason.message}` : "disconnected");
      this.set({ status: "closed", syncing: false, error: reason ? reason.message : this.state.error });
      this.log("link", reason ? `link dropped: ${reason.message}` : "disconnected");
    });

    try {
      const device = await client.deviceQuery();
      const selfInfo = await client.appStart(this.appName);
      const key = toHex(selfInfo.publicKey);
      const { publicKey: _omit, ...rest } = selfInfo;
      const self = { ...rest, key, prefix: key.slice(0, PUB_KEY_PREFIX_SIZE * 2) };

      const persisted = this.storage ? await this.storage.load(key) : null;
      const now = this.now();
      // Contacts saved before route ages were kept have none: a route of theirs
      // is dated as a route learned while nobody was listening.
      const contacts: Record<string, ContactRecord> = {};
      for (const [k, c] of Object.entries(persisted?.contacts ?? {})) {
        contacts[k] = c.pathSince !== undefined ? c : { ...c, pathSince: c.outPathLen === 0xff ? null : guessPathSince(c.lastMod, now) };
      }
      this.set({
        device,
        self,
        contacts,
        contactsCursor: persisted?.contactsCursor ?? 0,
        channels: persisted?.channels ?? [],
        // History saved before the hop count was masked holds the raw path_len
        // byte (the low six bits are the hops either way), and history saved
        // before echoes were kept has none.
        messages: (persisted?.messages ?? []).map((m) => ({ ...m, hops: m.hops === null ? null : m.hops & 63, echoes: m.echoes ?? [], route: m.route ?? null })),
        unread: persisted?.unread ?? {},
        logins: persisted?.logins ?? {},
        statusHistory: persisted?.statusHistory ?? {},
        routing: persisted?.routing ?? EMPTY.routing,
      });
      this.log("link", `connected to ${self.name} (${device.firmwareVersion})`);

      await this.syncClock();
      await this.refreshContacts();
      await this.refreshChannels();
      this.set({ status: "ready" });
      this.routeTimer = setInterval(() => void this.sweepRoutes(), ROUTE_SWEEP_MS);
      // Node keeps a process alive for an interval; a browser has no such notion.
      (this.routeTimer as { unref?: () => void }).unref?.();
      await this.syncMessages();
      void this.flushQueue();
      void this.refreshBattery();
      void this.sweepRoutes();
    } catch (error) {
      const message = (error as Error).message;
      if (this.client === client) {
        this.set({ error: message });
        this.log("error", `connect failed: ${message}`);
      }
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    if (!client) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      await this.saveNow();
    }
    await client.close();
  }

  /** The radio's clock is set from ours when it lags; it refuses to go back, so a lead is left. */
  async syncClock(): Promise<void> {
    const client = this.need();
    const radio = await client.getDeviceTime();
    const ours = Math.floor(this.now() / 1000);
    if (radio < ours - 30) {
      await client.setDeviceTime(ours);
      this.log("clock", `radio clock was ${ours - radio} s behind; set`);
    }
  }

  // ---- contacts ----

  async refreshContacts(full = false): Promise<void> {
    const client = this.need();
    const since = full || this.state.contactsCursor === 0 ? undefined : this.state.contactsCursor;
    const { total, contacts: fresh, mostRecentLastMod } = await client.getContacts(since);
    const contacts = { ...this.state.contacts };
    const now = this.now();
    for (const c of fresh) {
      const previous = contacts[toHex(c.publicKey)];
      const record = toRecord(c, previous?.lastHeardAt ?? null, previous, now);
      contacts[record.key] = record;
    }
    const cursor = Math.max(this.state.contactsCursor, mostRecentLastMod);
    this.set({ contacts, contactsCursor: cursor });
    this.rebindOrphans();
    // Fewer on the radio than we remember: it was reset, or contacts were
    // removed by another app. The cursor cannot say which, so ask for all.
    if (since !== undefined && total < Object.keys(contacts).length) {
      await this.reconcileContacts(client);
    }
  }

  private async reconcileContacts(client: MeshCoreClient): Promise<void> {
    const { contacts: fresh, mostRecentLastMod } = await client.getContacts();
    const contacts: Record<string, ContactRecord> = {};
    const now = this.now();
    for (const c of fresh) {
      const key = toHex(c.publicKey);
      const previous = this.state.contacts[key];
      contacts[key] = toRecord(c, previous?.lastHeardAt ?? null, previous, now);
    }
    this.set({ contacts, contactsCursor: mostRecentLastMod });
  }

  private queueContactsRefresh(): void {
    if (this.contactsRefreshQueued) return;
    this.contactsRefreshQueued = true;
    setTimeout(() => {
      this.contactsRefreshQueued = false;
      if (this.isReady) this.refreshContacts().catch((e: Error) => this.log("error", e.message));
    }, 500);
  }

  /** Messages filed under a bare prefix are moved to the contact once one is known. */
  private rebindOrphans(): void {
    let changed = false;
    const byPrefix = new Map<string, ContactRecord>();
    for (const c of Object.values(this.state.contacts)) byPrefix.set(c.prefix, c);
    const messages = this.state.messages.map((m) => {
      if (!m.conversation.startsWith("p:")) return m;
      const contact = byPrefix.get(m.conversation.slice(2));
      if (!contact) return m;
      changed = true;
      // A room post keeps its author; only a direct message is named after its sender.
      const sender = m.txtType === TxtType.SignedPlain ? m.sender : contact.name;
      return { ...m, conversation: contactConversation(contact.key), sender };
    });
    if (!changed) return;
    const unread: Record<string, number> = {};
    for (const [conv, n] of Object.entries(this.state.unread)) {
      const contact = conv.startsWith("p:") ? byPrefix.get(conv.slice(2)) : null;
      const target = contact ? contactConversation(contact.key) : conv;
      unread[target] = (unread[target] ?? 0) + n;
    }
    this.set({ messages, unread });
  }

  /** `learnedAt` is set when the radio has just said it learned this contact's route. */
  private upsertContact(contact: Contact, heard: boolean, learnedAt?: number): ContactRecord {
    const key = toHex(contact.publicKey);
    const previous = this.state.contacts[key];
    const record = toRecord(contact, heard ? this.now() : (previous?.lastHeardAt ?? null), previous, this.now(), learnedAt);
    this.set({ contacts: { ...this.state.contacts, [key]: record } });
    this.rebindOrphans();
    return record;
  }

  contactByPrefix(prefix: string): ContactRecord | null {
    for (const c of Object.values(this.state.contacts)) if (c.prefix === prefix) return c;
    return null;
  }

  /** A contact whose key starts with this hex, however short; ourselves included. */
  contactByKeyStart(hex: string): ContactRecord | { name: string } | null {
    if (this.state.self && this.state.self.key.startsWith(hex)) return { name: this.state.self.name };
    for (const c of Object.values(this.state.contacts)) if (c.key.startsWith(hex)) return c;
    return null;
  }

  private contactBytes(key: string): Uint8Array {
    if (!this.state.contacts[key]) throw new Error("unknown contact");
    return fromHex(key);
  }

  async removeContact(key: string): Promise<void> {
    await this.need().removeContact(this.contactBytes(key));
    const contacts = { ...this.state.contacts };
    delete contacts[key];
    this.set({ contacts });
  }

  async setFavourite(key: string, favourite: boolean): Promise<void> {
    const contact = this.state.contacts[key];
    if (!contact) throw new Error("unknown contact");
    const flags = favourite ? contact.flags | ContactFlag.Favourite : contact.flags & ~ContactFlag.Favourite;
    await this.writeContact({ ...contact, flags });
  }

  async renameContact(key: string, name: string): Promise<void> {
    const contact = this.state.contacts[key];
    if (!contact) throw new Error("unknown contact");
    await this.writeContact({ ...contact, name });
  }

  private async writeContact(record: ContactRecord): Promise<void> {
    const client = this.need();
    const lastMod = unixNow();
    await client.addUpdateContact({
      publicKey: fromHex(record.key),
      type: record.type,
      flags: record.flags,
      outPathLen: record.outPathLen,
      outPath: fromHex(record.outPath),
      name: record.name,
      lastAdvert: record.lastAdvert,
      lat: record.lat,
      lon: record.lon,
      lastMod,
    });
    this.set({ contacts: { ...this.state.contacts, [record.key]: { ...record, lastMod } } });
  }

  async resetPath(key: string): Promise<void> {
    await this.dropRoute(this.need(), key, "forgotten by hand");
  }

  // ---- routes ----
  //
  // The radio sends a direct message along the route it last learned for the
  // contact, and floods only when it knows none. It keeps a route until a new
  // one replaces it, however long ago the contact moved away. So the session
  // drops routes: before every message to a contact whose flood is pinned, and
  // once a route is older than its time limit. A dropped route costs nothing
  // on the air; the next message floods and its acknowledgement brings a
  // fresh route back.

  /** What governs this contact's route once the defaults are filled in. */
  routePolicy(key: string): { flood: boolean; resetAfterMin: number | null } {
    const own = this.state.routing.contacts[key] ?? {};
    return {
      flood: own.flood ?? false,
      resetAfterMin: own.resetAfterMin !== undefined ? own.resetAfterMin : this.state.routing.resetAfterMin,
    };
  }

  /** Local ms at which the route to this contact will be dropped for its age; null when it will not be. */
  routeExpiresAt(key: string): number | null {
    const contact = this.state.contacts[key];
    if (!contact || contact.outPathLen === 0xff || contact.pathSince === null || !isConversationType(contact.type)) return null;
    const { flood, resetAfterMin } = this.routePolicy(key);
    if (flood || resetAfterMin === null) return null;
    return contact.pathSince + resetAfterMin * 60_000;
  }

  /** Pins every message to this contact to a flood, or lets it use learned routes again. */
  async setFloodPinned(key: string, flood: boolean): Promise<void> {
    const contact = this.needContact(key);
    this.setPolicy(key, { flood });
    this.log("path", `${contact.name || key.slice(0, 12)}: ${flood ? "messages always flood" : "learned routes are used again"}`);
    if (flood && this.isReady && contact.outPathLen !== 0xff) await this.dropRoute(this.need(), key, "flood pinned");
  }

  /** Minutes a learned route to this contact is kept; null keeps it; undefined follows the default. */
  setRouteReset(key: string, minutes: number | null | undefined): void {
    this.needContact(key);
    this.setPolicy(key, { resetAfterMin: minutes });
    void this.sweepRoutes();
  }

  /** Minutes a learned route to a chat or a room is kept unless the contact says otherwise; null keeps it. */
  setDefaultRouteReset(minutes: number | null): void {
    this.set({ routing: { ...this.state.routing, resetAfterMin: minutes } });
    void this.sweepRoutes();
  }

  private setPolicy(key: string, patch: { flood?: boolean; resetAfterMin?: number | null | undefined; manual?: string | undefined }): void {
    const current = this.state.routing.contacts[key] ?? {};
    const flood = "flood" in patch ? patch.flood : current.flood;
    const resetAfterMin = "resetAfterMin" in patch ? patch.resetAfterMin : current.resetAfterMin;
    const manual = "manual" in patch ? patch.manual : current.manual;
    // What follows the default is stored as absence.
    const policy: RoutePolicy = {};
    if (flood) policy.flood = true;
    if (resetAfterMin !== undefined) policy.resetAfterMin = resetAfterMin;
    if (manual !== undefined) policy.manual = manual;
    const contacts = { ...this.state.routing.contacts };
    if (Object.keys(policy).length === 0) delete contacts[key];
    else contacts[key] = policy;
    this.set({ routing: { ...this.state.routing, contacts } });
  }

  /**
   * Writes the route to a contact by hand: the relays in order, as hex hashes
   * of one size, none for a neighbour heard direct. It unpins a flood, and is
   * kept past the time limit until the radio learns a route of its own.
   */
  async setRoute(key: string, hashes: string[]): Promise<void> {
    const contact = this.needContact(key);
    const size = hashes[0] ? hashes[0].length / 2 : (this.state.device?.pathHashMode ?? 0) + 1;
    if (!Number.isInteger(size) || size < 1 || size > 4 || hashes.some((h) => h.length !== size * 2 || !/^[0-9a-f]+$/.test(h)) || hashes.length > 63 || hashes.length * size > 64) {
      throw new Error("not a route the radio can hold");
    }
    const outPathLen = hashes.length | ((size - 1) << 6);
    // Kept at the radio's full width, as it hands contacts back.
    const outPath = hashes.join("").padEnd(128, "0");
    await this.writeContact({ ...contact, outPathLen, outPath, pathSince: this.now() });
    this.setPolicy(key, { flood: false, manual: routeKey(outPathLen, outPath) });
    this.log("path", `${contact.name || key.slice(0, 12)}: route set by hand, ${hashes.length ? hashes.join(" ") : "direct"}`);
  }

  /** Whether the route the radio holds for this contact is the one last written by hand. */
  routeSetByHand(key: string): boolean {
    const contact = this.state.contacts[key];
    const manual = this.state.routing.contacts[key]?.manual;
    return !!contact && !!manual && contact.outPathLen !== 0xff && manual === routeKey(contact.outPathLen, contact.outPath);
  }

  /** Why the route to this contact should go now, or null if it may stay. */
  private staleReason(contact: ContactRecord): string | null {
    if (contact.outPathLen === 0xff || !isConversationType(contact.type)) return null;
    const { flood, resetAfterMin } = this.routePolicy(contact.key);
    if (flood) return "flood pinned";
    if (this.routeSetByHand(contact.key)) return null;
    if (resetAfterMin === null || contact.pathSince === null) return null;
    return this.now() - contact.pathSince >= resetAfterMin * 60_000 ? `older than ${resetAfterMin} min` : null;
  }

  private async dropRoute(client: MeshCoreClient, key: string, reason: string): Promise<void> {
    if (this.droppingRoutes.has(key)) return;
    this.droppingRoutes.add(key);
    try {
      await client.resetPath(this.contactBytes(key));
      const contact = this.state.contacts[key];
      if (!contact) return;
      this.set({ contacts: { ...this.state.contacts, [key]: { ...contact, outPathLen: 0xff, pathSince: null } } });
      this.log("path", `route to ${contact.name || key.slice(0, 12)} dropped: ${reason}`);
    } finally {
      this.droppingRoutes.delete(key);
    }
  }

  /** Drops every route past its time or pinned to a flood. Runs on a timer while connected. */
  private async sweepRoutes(): Promise<void> {
    const client = this.client;
    if (!client || client.isClosed || this.state.status !== "ready") return;
    for (const contact of Object.values(this.state.contacts)) {
      const reason = this.staleReason(contact);
      if (!reason) continue;
      try {
        await this.dropRoute(client, contact.key, reason);
      } catch (error) {
        this.log("error", `could not drop the route to ${contact.name}: ${(error as Error).message}`);
      }
    }
  }

  async shareContact(key: string): Promise<void> {
    await this.need().shareContact(this.contactBytes(key));
  }

  /** The bytes of an advert, as `exportContact` gives them or a link carries them. */
  async importContact(advert: Uint8Array): Promise<void> {
    await this.need().importContact(advert);
    await this.refreshContacts();
  }

  exportContact(key?: string): Promise<Uint8Array> {
    return this.need().exportContact(key ? this.contactBytes(key) : undefined);
  }

  // ---- channels ----

  async refreshChannels(): Promise<void> {
    const client = this.need();
    const max = this.state.device?.maxChannels ?? 8;
    const channels: ChannelRecord[] = [];
    for (let i = 0; i < max; i++) {
      try {
        const ch = await client.getChannel(i);
        const secret = toHex(ch.secret);
        if (ch.name === "" && /^0+$/.test(secret)) continue;
        channels.push({ index: i, name: ch.name, secret });
      } catch (error) {
        if (error instanceof MeshCoreError) break;
        throw error;
      }
    }
    this.set({ channels });
  }

  async setChannel(index: number, name: string, secret: Uint8Array): Promise<void> {
    await this.need().setChannel(index, name, secret);
    const record: ChannelRecord = { index, name, secret: toHex(secret) };
    const channels = this.state.channels.filter((c) => c.index !== index).concat(record);
    channels.sort((a, b) => a.index - b.index);
    this.set({ channels });
  }

  async clearChannel(index: number): Promise<void> {
    await this.need().setChannel(index, "", new Uint8Array(16));
    this.set({ channels: this.state.channels.filter((c) => c.index !== index) });
  }

  // ---- messages ----

  /** The conversation on screen; its messages arrive read. */
  focus(conversation: string | null): void {
    this.focused = conversation;
    if (conversation) this.markRead(conversation);
  }

  markRead(conversation: string): void {
    if (!this.state.unread[conversation]) return;
    const unread = { ...this.state.unread };
    delete unread[conversation];
    this.set({ unread });
  }

  deleteConversation(conversation: string): void {
    const unread = { ...this.state.unread };
    delete unread[conversation];
    this.set({ messages: this.state.messages.filter((m) => m.conversation !== conversation), unread });
  }

  /** Drains the radio's queue. Re-entrant calls collapse into one more pass. */
  async syncMessages(): Promise<void> {
    if (this.state.syncing) {
      this.syncQueued = true;
      return;
    }
    const client = this.need();
    this.set({ syncing: true });
    let retries = 0;
    try {
      do {
        this.syncQueued = false;
        for (;;) {
          let frame;
          try {
            frame = await client.syncNextMessage();
          } catch (error) {
            // A lost USB frame need not mean a lost link. Give the stream a
            // quiet interval to discard its partial frame, then resume draining.
            if (
              !(error instanceof TimeoutError) || client.transport.kind !== "serial" ||
              retries >= 2 || this.client !== client || client.isClosed
            ) throw error;
            retries += 1;
            this.log("error", `${error.message}; retrying message sync (${retries}/2)`);
            await new Promise((resolve) => setTimeout(resolve, 1000));
            if (this.client !== client || client.isClosed) throw error;
            continue;
          }
          retries = 0;
          if (!frame) break;
          this.receive(frame);
        }
      } while (this.syncQueued);
    } finally {
      if (this.client === client) this.set({ syncing: false });
    }
  }

  private receive(frame: NonNullable<Awaited<ReturnType<MeshCoreClient["syncNextMessage"]>>>): void {
    const now = this.now();
    let message: MessageRecord;
    if (frame.kind === "contactMessage") {
      const prefix = toHex(frame.senderPrefix);
      if (frame.txtType === TxtType.CliData) {
        this.receiveCli(prefix, frame.text);
        return;
      }
      const contact = this.contactByPrefix(prefix);
      if (!contact) this.queueContactsRefresh();
      // A room relays its members' posts signed with the author's key prefix.
      const signer = frame.signerPrefix ? toHex(frame.signerPrefix) : null;
      const author = signer ? this.contactByKeyStart(signer) : null;
      message = {
        id: newId(now),
        conversation: contact ? contactConversation(contact.key) : `p:${prefix}`,
        direction: "in",
        text: frame.text,
        sender: signer ? (author?.name ?? signer) : (contact?.name ?? null),
        senderPrefix: signer ?? prefix,
        timestamp: frame.timestamp,
        receivedAt: now,
        snr: frame.snr,
        hops: frame.pathLen,
        txtType: frame.txtType,
        status: null,
        ackTag: null,
        roundTripMs: null,
        flood: null,
        attempt: 0,
        error: null,
        echoes: [],
        route: null,
      };
    } else if (frame.kind === "channelMessage") {
      const { sender, text } = splitChannelText(frame.text);
      message = {
        id: newId(now),
        conversation: channelConversation(frame.channelIndex),
        direction: "in",
        text,
        sender,
        senderPrefix: null,
        timestamp: frame.timestamp,
        receivedAt: now,
        snr: frame.snr,
        hops: frame.pathLen,
        txtType: frame.txtType,
        status: null,
        ackTag: null,
        roundTripMs: null,
        flood: null,
        attempt: 0,
        error: null,
        echoes: [],
        route: null,
      };
    } else {
      this.log("channelData", `channel ${frame.channelIndex} type ${frame.dataType}: ${toHex(frame.data)}`);
      return;
    }
    const unread =
      this.focused === message.conversation
        ? this.state.unread
        : { ...this.state.unread, [message.conversation]: (this.state.unread[message.conversation] ?? 0) + 1 };
    this.set({ messages: [...this.state.messages, message], unread });
    for (const listener of this.receivedListeners) {
      try {
        listener(message);
      } catch (error) {
        console.error("received listener threw", error);
      }
    }
    if (frame.kind === "channelMessage") {
      void this.findChannelCopies(message.id, frame.channelIndex, frame.timestamp, frame.txtType, frame.text);
    } else if (frame.pathLen !== null && message.senderPrefix) {
      this.findDirectCopies(message.id, toHex(frame.senderPrefix), frame.pathLen);
    }
  }

  // ---- the copies the radio heard ----
  //
  // The radio hands up a message with its hop count only; the path it took is
  // in the packet, which the radio also hands up whole (`logRxData`) as it
  // hears it, a moment before the message itself, and once more for every
  // other copy a repeater sends its way. Those packets are kept for a little
  // while and matched to messages: a channel message by its payload, which
  // can be worked out exactly; a direct message, sealed with a key this side
  // does not hold, by who it is to and from and how far it came.

  private async findChannelCopies(id: string, channelIndex: number, timestamp: number, txtType: number, text: string): Promise<void> {
    const channel = this.state.channels.find((c) => c.index === channelIndex);
    if (!channel) return;
    try {
      const payload = await heardGroupTextPayload(fromHex(channel.secret), timestamp, txtType, text);
      this.adoptCopies(id, toHex(payload));
    } catch (error) {
      this.log("echo", `cannot work out the payload: ${(error as Error).message}`);
    }
  }

  /** A flooded direct message: its packet names us and the sender by their first key byte, and came as many hops. */
  private findDirectCopies(id: string, senderPrefix: string, hops: number): void {
    const self = this.state.self;
    if (!self) return;
    const to = parseInt(self.key.slice(0, 2), 16);
    const from = parseInt(senderPrefix.slice(0, 2), 16);
    const now = this.now();
    const first = this.heard.find(
      (h) =>
        now - h.at <= DM_MATCH_MS &&
        h.packet.payloadType === PayloadType.TxtMsg &&
        h.packet.path.length === hops &&
        h.packet.payload[0] === to &&
        h.packet.payload[1] === from &&
        !this.claimed.has(h.hex),
    );
    if (!first) return;
    this.claimed.add(first.hex);
    this.adoptCopies(id, first.hex);
  }

  /** Every copy of this payload heard so far goes on the message, and later ones will. */
  private adoptCopies(id: string, hex: string): void {
    const now = this.now();
    this.pruneWatch(now);
    this.echoWatch.set(hex, { id, at: now, incoming: true });
    for (const h of this.heard) if (h.hex === hex) this.addEcho(id, h.packet.path, h.snr);
  }

  private pruneWatch(now: number): void {
    for (const [key, watch] of this.echoWatch) {
      if (now - watch.at > (watch.incoming ? IN_ECHO_WINDOW_MS : ECHO_WINDOW_MS)) this.echoWatch.delete(key);
    }
  }

  private addEcho(id: string, path: string[], snr: number): void {
    const message = this.state.messages.find((m) => m.id === id);
    if (!message) return;
    const key = path.join(",");
    if (message.echoes.some((e) => e.path.join(",") === key)) return;
    this.patchMessage(id, { echoes: [...message.echoes, { path, snr }] });
  }

  private patchMessage(id: string, patch: Partial<MessageRecord>): void {
    const messages = this.state.messages.map((m) => (m.id === id ? { ...m, ...patch } : m));
    this.set({ messages });
  }

  /**
   * Sends text to a conversation and records it; the record's status follows
   * the ack. `original` is what was typed, when `text` was reworked to fit.
   * `flood` drops a contact's route first, so that this message floods. With
   * the radio away the message is queued, and goes out once it is back.
   */
  async sendText(conversation: string, text: string, options: { original?: string; flood?: boolean } = {}): Promise<MessageRecord> {
    const target = parseConversation(conversation);
    if (target.kind === "prefix") throw new Error("this sender is not in the contacts yet");
    const client = this.isReady ? this.client : null;
    const now = this.now();
    const message: MessageRecord = {
      id: newId(now),
      conversation,
      direction: "out",
      text,
      sender: this.state.self?.name ?? null,
      senderPrefix: this.state.self?.prefix ?? null,
      timestamp: Math.floor(now / 1000),
      receivedAt: now,
      snr: null,
      hops: null,
      txtType: TxtType.Plain,
      status: client ? "sending" : "queued",
      ackTag: null,
      roundTripMs: null,
      // A queued message keeps the wish to flood here until it goes; the send then says how it went.
      flood: !client && options.flood ? true : null,
      attempt: 0,
      error: null,
      echoes: [],
      route: null,
      ...(options.original !== undefined && options.original !== text ? { original: options.original } : {}),
    };
    this.set({ messages: [...this.state.messages, message] });
    if (!client) return message;
    await this.transmit(client, message, target, options.flood ? "flood asked for" : false);
    return this.state.messages.find((m) => m.id === message.id) ?? message;
  }

  /**
   * Sends what was written while the radio was away, oldest first. A new
   * message goes out stamped with the moment it is sent: the others sort by
   * the sender's clock, and an hour-old stamp would file it an hour back in
   * their chats. A retry keeps its stamp, being the same message again.
   */
  private async flushQueue(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      let last = 0;
      for (;;) {
        const client = this.isReady ? this.client : null;
        const next = this.state.messages.find((m) => m.status === "queued");
        if (!client || !next) return;
        const timestamp = next.attempt > 0 ? next.timestamp : Math.max(Math.floor(this.now() / 1000), last + 1);
        last = timestamp;
        this.patchMessage(next.id, { status: "sending", timestamp });
        try {
          await this.transmit(client, { ...next, timestamp }, parseConversation(next.conversation), next.flood === true ? "flood asked for" : false);
        } catch {
          // The record says it failed; the rest still go.
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Takes back a message still waiting for the radio. */
  discardQueued(id: string): void {
    const messages = this.state.messages.filter((m) => !(m.id === id && m.status === "queued"));
    if (messages.length !== this.state.messages.length) this.set({ messages });
  }

  /**
   * Sends an unconfirmed or failed message again, one attempt up. A direct
   * message that went unacknowledged along a learned route floods this time:
   * the route is the likeliest thing to have broken.
   */
  async retry(id: string): Promise<void> {
    const message = this.state.messages.find((m) => m.id === id);
    if (!message || message.direction !== "out") throw new Error("not an outgoing message");
    const attempt = message.attempt + 1;
    const flood = message.status === "unconfirmed" && message.flood === false;
    if (!this.isReady) {
      // It goes again with the queue, once the radio is back.
      this.patchMessage(id, { status: "queued", error: null, attempt, ackTag: null, roundTripMs: null, route: null, flood: flood ? true : null });
      return;
    }
    const client = this.need();
    this.patchMessage(id, { status: "sending", error: null, attempt, ackTag: null, roundTripMs: null, route: null });
    await this.transmit(client, { ...message, attempt }, parseConversation(message.conversation), flood ? "no acknowledgement" : false);
  }

  /** Whether a retry of this message will drop the route and flood. */
  retryFloods(message: MessageRecord): boolean {
    return message.direction === "out" && message.status === "unconfirmed" && message.flood === false && message.conversation.startsWith("c:");
  }

  /** `dropRoute`, when given, is why a contact's route is dropped before the send, so that it floods. */
  private async transmit(
    client: MeshCoreClient,
    message: MessageRecord,
    target: ReturnType<typeof parseConversation>,
    dropRoute: string | false = false,
  ): Promise<void> {
    try {
      if (target.kind === "channel") {
        await this.watchEchoes(message, target.index);
        await client.sendChannelTextMessage(target.index, message.text, {
          timestamp: message.timestamp,
          ...(this.state.self ? { senderName: this.state.self.name } : {}),
        });
        this.patchMessage(message.id, { status: "sent" });
        return;
      }
      if (target.kind !== "contact") throw new Error("unreachable");
      const contact = this.state.contacts[target.key];
      if (!contact) throw new Error("unknown contact");
      // The sweep runs every half minute and a phone may have slept through
      // it, so a route past its time is caught here too.
      const reason = contact.outPathLen === 0xff ? null : dropRoute || this.staleReason(contact);
      if (reason) {
        try {
          await this.dropRoute(client, contact.key, reason);
        } catch (error) {
          this.log("error", `could not drop the route to ${contact.name}: ${(error as Error).message}`);
        }
      }
      const route = contactRoute(this.state.contacts[target.key] ?? contact);
      // Past the fourth attempt the firmware hides the attempt number in two
      // bytes after the text, which a text this long has no room for, and
      // refuses the send; such a text goes round its four attempts again.
      const long = new TextEncoder().encode(message.text).length > MAX_TEXT_LEN - 2;
      const result = await client.sendTextMessage(fromHex(contact.prefix), message.text, {
        attempt: long && message.attempt > 3 ? message.attempt & 3 : message.attempt,
        timestamp: message.timestamp,
      });
      this.armAck(message.id, result, result.flood ? null : route);
    } catch (error) {
      this.patchMessage(message.id, { status: "failed", error: (error as Error).message });
      throw error;
    }
  }

  /**
   * Works out what the radio will put on the air for this message, so that
   * the copies repeaters send back can be told from everyone else's packets.
   * Done before the send: the first echo can be back within a second.
   */
  private async watchEchoes(message: MessageRecord, channelIndex: number): Promise<void> {
    const channel = this.state.channels.find((c) => c.index === channelIndex);
    if (!channel || !this.state.self) return;
    try {
      const payload = await groupTextPayload(fromHex(channel.secret), message.timestamp, this.state.self.name, message.text);
      const now = this.now();
      this.pruneWatch(now);
      this.echoWatch.set(toHex(payload), { id: message.id, at: now, incoming: false });
    } catch (error) {
      this.log("echo", `cannot work out the payload: ${(error as Error).message}`);
    }
  }

  /**
   * A text packet the radio heard: kept a while for a message that has not been
   * handed up yet, and added to one already known, ours coming back from a
   * repeater or another copy of one that came in.
   */
  private noteHeard(snr: number, raw: Uint8Array): void {
    const packet = parseRawPacket(raw);
    if (!packet || !packet.flood || (packet.payloadType !== PayloadType.GroupText && packet.payloadType !== PayloadType.TxtMsg)) return;
    const now = this.now();
    const hex = toHex(packet.payload);
    const kept = this.heard.filter((h) => now - h.at <= HEARD_WINDOW_MS);
    this.heard = [...kept.slice(-(HEARD_LIMIT - 1)), { at: now, snr, packet, hex }];
    for (const c of this.claimed) if (!this.heard.some((h) => h.hex === c)) this.claimed.delete(c);
    const watch = this.echoWatch.get(hex);
    if (!watch) return;
    // Ours is never heard from us: a copy with no relays in it is not an echo.
    if (!watch.incoming && packet.path.length === 0) return;
    this.addEcho(watch.id, packet.path, snr);
  }

  /** `route` is the path a direct message was sent along; a flood learns its own from the ack. */
  private armAck(id: string, result: TextSendResult, route: string[] | null = null): void {
    if (result.ackTag === 0) {
      this.patchMessage(id, { status: "sent", flood: result.flood, ackTag: null, route });
      return;
    }
    this.patchMessage(id, { status: "sent", flood: result.flood, ackTag: result.ackTag, route });
    const wait = Math.max(result.estTimeoutMs, 4000) * 1.5;
    const timer = setTimeout(() => {
      this.ackTimers.delete(id);
      const current = this.state.messages.find((m) => m.id === id);
      if (current?.status === "sent") this.patchMessage(id, { status: "unconfirmed" });
    }, wait);
    const previous = this.ackTimers.get(id);
    if (previous) clearTimeout(previous);
    this.ackTimers.set(id, timer);
  }

  /** How many bytes of text a message to this conversation may carry. */
  textBudget(conversation: string): number {
    const target = parseConversation(conversation);
    if (target.kind !== "channel") return MAX_TEXT_LEN;
    const name = this.state.self?.name ?? "";
    return MAX_TEXT_LEN - new TextEncoder().encode(name).length - 2;
  }

  // ---- the radio's own settings ----

  async setName(name: string): Promise<void> {
    await this.need().setAdvertName(name);
    if (this.state.self) this.set({ self: { ...this.state.self, name } });
  }

  async setLocation(lat: number, lon: number): Promise<void> {
    await this.need().setAdvertLatLon(lat, lon);
    if (this.state.self) this.set({ self: { ...this.state.self, lat, lon } });
  }

  async setRadioParams(params: RadioParams): Promise<void> {
    await this.need().setRadioParams(params);
    if (this.state.self) {
      this.set({
        self: {
          ...this.state.self,
          frequencyKhz: params.frequencyKhz,
          bandwidthHz: params.bandwidthHz,
          spreadingFactor: params.spreadingFactor,
          codingRate: params.codingRate,
        },
      });
    }
  }

  async setTxPower(dbm: number): Promise<void> {
    await this.need().setRadioTxPower(dbm);
    if (this.state.self) this.set({ self: { ...this.state.self, txPower: dbm } });
  }

  async setOtherParams(params: OtherParams): Promise<void> {
    await this.need().setOtherParams(params);
    if (this.state.self) {
      this.set({
        self: {
          ...this.state.self,
          manualAddContacts: params.manualAddContacts,
          telemetryModeBase: params.telemetryModeBase,
          telemetryModeLocation: params.telemetryModeLocation,
          telemetryModeEnvironment: params.telemetryModeEnvironment,
          advertLocPolicy: params.advertLocPolicy,
          multiAcks: params.multiAcks,
        },
      });
    }
  }

  async refreshTuning(): Promise<void> {
    const tuning = await this.need().getTuningParams();
    this.set({ tuning });
  }

  async setTuning(rxDelayBase: number, airtimeFactor: number): Promise<void> {
    await this.need().setTuningParams(rxDelayBase, airtimeFactor);
    this.set({ tuning: { rxDelayBase, airtimeFactor } });
  }

  async sendAdvert(flood: boolean): Promise<void> {
    await this.need().sendSelfAdvert(flood);
    this.log("advert", flood ? "advert flooded" : "advert sent zero-hop");
  }

  async refreshBattery(): Promise<void> {
    try {
      const { batteryMv } = await this.need().getBattAndStorage();
      this.set({ battery: { mv: batteryMv, at: this.now() } });
    } catch (error) {
      this.log("error", `battery: ${(error as Error).message}`);
    }
  }

  async reboot(): Promise<void> {
    await this.need().reboot();
  }

  async factoryReset(): Promise<void> {
    await this.need().factoryReset();
  }

  // ---- diagnostics ----
  //
  // A trace goes out along a path of hashes, each repeater on it adding how
  // well it heard the one before, and the radio hands it up when it gets back.
  // It takes no place in the queue for remote nodes below: the radio keeps no
  // pending request for it, only its tag. Nothing here goes out unless asked.

  /**
   * What a trace to this contact goes along: the relays of its route, and the
   * contact itself when it relays too. A repeater nobody has written to has
   * no route, but its adverts came in along one. Null when neither is known.
   */
  async pingPath(key: string): Promise<{ relays: string[]; target: string | null } | null> {
    const contact = this.needContact(key);
    let relays = contactRoute(contact);
    if (relays === null && contact.type === AdvType.Repeater && this.isReady) {
      try {
        const advert = await this.need().getAdvertPath(fromHex(key));
        relays = pathHashes(advert.pathLen, advert.path).reverse();
      } catch {
        relays = null;
      }
    }
    if (relays === null) return null;
    const size = relays[0] ? relays[0].length / 2 : (this.state.device?.pathHashMode ?? 0) + 1;
    return { relays, target: contact.type === AdvType.Repeater ? key.slice(0, size * 2) : null };
  }

  /**
   * One trace out along `hashes` and back the same way. Resolves with how it
   * came back, or null when it did not within the time the radio estimated.
   */
  async traceRoute(hashes: string[]): Promise<TraceResult | null> {
    if (hashes.length === 0) throw new Error("nothing to trace");
    const client = this.need();
    // A trace sizes its hashes in powers of two; a three-byte route is traced on two.
    const shortest = Math.min(...hashes.map((h) => h.length / 2));
    const size = shortest >= 4 ? 4 : shortest >= 2 ? 2 : 1;
    const path = [...hashes, ...hashes.slice(0, -1).reverse()].map((h) => h.slice(0, size * 2));
    const tag = randomU32();
    let arrive: (frame: Extract<PushFrame, { kind: "traceData" }>) => void = () => undefined;
    const back = new Promise<Extract<PushFrame, { kind: "traceData" }>>((resolve) => (arrive = resolve));
    this.traceWaiters.set(tag, (frame) => arrive(frame));
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const sent = await client.sendTracePath(tag, 0, Math.log2(size), fromHex(path.join("")));
      const started = this.now();
      const wait = this.traceWait(sent.estTimeoutMs);
      const frame = await Promise.race([back, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), wait)))]);
      if (!frame) {
        this.log("trace", `${path.join(" ")}: no answer in ${(wait / 1000).toFixed(1)} s`);
        return null;
      }
      const rttMs = Math.max(0, this.now() - started);
      this.log("trace", `${path.join(" ")}: back in ${rttMs} ms, snr ${frame.snrs.map((x) => x.toFixed(2)).join(" / ")}`);
      return { rttMs, snrs: frame.snrs };
    } finally {
      if (timer) clearTimeout(timer);
      this.traceWaiters.delete(tag);
    }
  }

  /**
   * Asks the repeaters in direct range how well they hear this radio, and
   * listens for `listenMs`. Each answers after a random pause, and no more
   * than four times in two minutes; `onReply` hears each answer as it comes.
   */
  async discoverRepeaters(listenMs = 10_000, onReply?: (reply: DiscoverReply) => void): Promise<DiscoverReply[]> {
    const client = this.need();
    const tag = randomU32();
    const replies = new Map<string, DiscoverReply>();
    const listener = (frame: Extract<PushFrame, { kind: "controlData" }>) => {
      const p = frame.payload;
      if (p.length < 14 || (p[0]! & 0xf0) !== ControlType.NodeDiscoverResp) return;
      if ((p[2]! | (p[3]! << 8) | (p[4]! << 16) | (p[5]! << 24)) >>> 0 !== tag) return;
      const hex = toHex(p.subarray(6));
      const contact = Object.values(this.state.contacts).find((c) => c.key.startsWith(hex)) ?? null;
      const reply: DiscoverReply = {
        key: contact?.key ?? hex,
        known: contact !== null,
        type: p[0]! & 0x0f,
        heardUs: ((p[1]! << 24) >> 24) / 4,
        heardThem: frame.snr,
        rssi: frame.rssi,
        at: this.now(),
      };
      replies.set(reply.key, reply);
      onReply?.(reply);
    };
    this.controlListeners.add(listener);
    try {
      await client.sendControlData(nodeDiscoverRequest(tag, 1 << AdvType.Repeater));
      this.log("discover", "asked who hears this radio");
      await new Promise((resolve) => setTimeout(resolve, listenMs));
    } finally {
      this.controlListeners.delete(listener);
    }
    this.log("discover", `${replies.size} repeater(s) answered`);
    return [...replies.values()];
  }

  /** The radio's own receiver: its noise floor, and how long it has been on the air. Asked of the radio, not of the air. */
  async radioStats(): Promise<RadioStats> {
    const frame = await this.need().getStats(StatsType.Radio);
    if (frame.kind !== "statsRadio") throw new Error(`radio stats: the radio answered ${frame.kind}`);
    const { noiseFloor, lastRssi, lastSnr, txAirSecs, rxAirSecs } = frame;
    return { noiseFloor, lastRssi, lastSnr, txAirSecs, rxAirSecs, at: this.now() };
  }

  // ---- repeaters, rooms and sensors ----
  //
  // The radio keeps one request to a remote node pending at a time: each new
  // login, status, telemetry, path or binary request makes it forget the
  // last (`clearPendingReqs`), and a reply nobody is waiting for is dropped.
  // So they go through one queue here, each waiting for its reply or for the
  // time the radio estimated before the next is sent. Console commands do not
  // take the radio's slot, but they share the air and queue here all the same.

  private needContact(key: string): ContactRecord {
    const contact = this.state.contacts[key];
    if (!contact) throw new Error("unknown contact");
    return contact;
  }

  /** Signs in. Resolves with what the node said, `ok: false` when it refused the password. */
  async login(key: string, password: string): Promise<NodeLogin> {
    const contact = this.needContact(key);
    const bytes = fromHex(key);
    await this.remoteRequest(
      key,
      "sign in",
      (client) => client.sendLogin(bytes, password),
      (event) => event.kind === "login" && event.prefix === contact.prefix,
    );
    return this.state.logins[key]!;
  }

  /** Ends a room's keep-alive and forgets the role; the node keeps its own record of us. */
  async logout(key: string): Promise<void> {
    await this.need().logout(this.contactBytes(key));
    const logins = { ...this.state.logins };
    delete logins[key];
    this.set({ logins });
  }

  async requestStatus(key: string): Promise<NodeStatus> {
    const contact = this.needContact(key);
    const bytes = fromHex(key);
    await this.remoteRequest(
      key,
      "status",
      (client) => client.sendStatusReq(bytes),
      (event) => event.kind === "status" && event.prefix === contact.prefix,
    );
    return this.state.statuses[key]!;
  }

  /** Without a key, the radio's own sensors, answered at once and outside the queue. */
  async requestTelemetry(key?: string): Promise<LppReading[] | null> {
    if (!key) {
      await this.need().sendTelemetryReq();
      return null;
    }
    const contact = this.needContact(key);
    const bytes = fromHex(key);
    const event = await this.remoteRequest(
      key,
      "telemetry",
      (client) => client.sendTelemetryReq(bytes).then((sent) => sent!),
      (event) => event.kind === "telemetry" && event.prefix === contact.prefix,
    );
    return event.kind === "telemetry" ? event.readings : null;
  }

  async discoverPath(key: string): Promise<void> {
    const contact = this.needContact(key);
    const bytes = fromHex(key);
    await this.remoteRequest(
      key,
      "path discovery",
      (client) => client.sendPathDiscoveryReq(bytes),
      (event) => event.kind === "path" && event.prefix === contact.prefix,
    );
  }

  /** A page of the repeaters a repeater hears direct. A page past the first is added to what was fetched. */
  async requestNeighbours(key: string, options: { order?: number; offset?: number; count?: number } = {}): Promise<NeighbourList> {
    const order = options.order ?? 0;
    const offset = options.offset ?? 0;
    const data = await this.binaryRequest(key, offset > 0 ? "more neighbours" : "neighbours", neighboursRequest({ order, offset, count: options.count ?? 10 }));
    const { total, neighbours } = readNeighbours(data);
    const page = neighbours.map((n) => ({ prefix: toHex(n.prefix), heardSecsAgo: n.heardSecsAgo, snr: n.snr }));
    const prior = this.state.neighbours[key];
    const list = offset > 0 && prior && prior.order === order ? [...prior.neighbours.slice(0, offset), ...page] : page;
    const record: NeighbourList = { total, order, neighbours: list, at: this.now() };
    this.set({ neighbours: { ...this.state.neighbours, [key]: record } });
    return record;
  }

  async requestAccessList(key: string): Promise<AccessRecord[]> {
    const data = await this.binaryRequest(key, "access list", accessListRequest());
    const entries = readAccessList(data).map((e) => ({ prefix: toHex(e.prefix), permissions: e.permissions }));
    this.set({ accessLists: { ...this.state.accessLists, [key]: { entries, at: this.now() } } });
    return entries;
  }

  async requestOwnerInfo(key: string): Promise<OwnerInfo> {
    const data = await this.binaryRequest(key, "owner info", ownerInfoRequest());
    const info: OwnerInfo = { ...readOwnerInfo(data), at: this.now() };
    this.set({ ownerInfo: { ...this.state.ownerInfo, [key]: info } });
    return info;
  }

  /** A sensor's min, max and mean of each series over the last `windowSecs`. */
  async requestSeries(key: string, windowSecs: number): Promise<SeriesWindow> {
    const data = await this.binaryRequest(key, "min/max/avg", avgMinMaxRequest(windowSecs, 0));
    const { time, series } = readAvgMinMax(data);
    const record: SeriesWindow = { windowSecs, time, series, at: this.now() };
    this.set({ series: { ...this.state.series, [key]: record } });
    return record;
  }

  private async binaryRequest(key: string, label: string, body: Uint8Array): Promise<Uint8Array> {
    this.needContact(key);
    const bytes = fromHex(key);
    const event = await this.remoteRequest(
      key,
      label,
      (client) => client.sendBinaryReq(bytes, body),
      (event, sent) => event.kind === "binary" && sent !== null && event.tag === sent.ackTag,
    );
    if (event.kind !== "binary") throw new Error("unreachable");
    return event.data;
  }

  /**
   * Runs a console command on a node and resolves with its reply. The node
   * answers admins only, and says nothing to a retry of a command it has
   * seen. `mask` is what the console shows in place of the command and its
   * reply, for a command that carries a password.
   */
  async runCli(key: string, command: string, options: { mask?: string } = {}): Promise<string> {
    const contact = this.needContact(key);
    const tag = (this.cliTag++ & 0xff).toString(16).padStart(2, "0");
    const prefix = fromHex(contact.prefix);
    if (options.mask) this.maskedTags.add(`${contact.prefix}:${tag}`);
    const entry: ConsoleEntry = {
      id: newId(this.now()),
      command: options.mask ?? command,
      tag,
      at: this.now(),
      status: "queued",
      reply: null,
      repliedAt: null,
      error: null,
    };
    this.appendConsole(key, entry);
    try {
      const event = await this.remoteRequest(
        key,
        options.mask ?? command,
        (client) => client.sendCliCommand(prefix, `${tag}|${command}`),
        (event) => event.kind === "cli" && event.prefix === contact.prefix && event.tag === tag,
        // The node holds a console reply back for about half a second.
        1_500,
        () => this.patchConsole(key, entry.id, { status: "waiting", at: this.now() }),
      );
      const reply = event.kind === "cli" ? event.text : "";
      this.patchConsole(key, entry.id, { status: "done", reply: options.mask ? maskReply(reply) : reply, repliedAt: this.now() });
      return reply;
    } catch (error) {
      this.patchConsole(key, entry.id, {
        status: error instanceof NoReplyError ? "timeout" : "failed",
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /** `get <name>`, or another command whose reply is the value; remembered per node. */
  async readNodeSetting(key: string, name: string, command = `get ${name}`): Promise<string> {
    const reply = await this.runCli(key, command);
    if (isCliError(reply)) throw new NodeCommandError(reply);
    // `get` answers "> value"; a few commands (powersaving) answer the bare value.
    const value = cliValue(reply) ?? reply.trim();
    this.storeSetting(key, name, value);
    return value;
  }

  /** `set <name> <value>`, or the command given; the value is remembered when the node says OK. */
  async writeNodeSetting(key: string, name: string, value: string, command = `set ${name} ${value}`, options: { mask?: string } = {}): Promise<string> {
    const reply = await this.runCli(key, command, options);
    if (isCliError(reply)) throw new NodeCommandError(reply);
    if (!options.mask) this.storeSetting(key, name, value);
    return reply;
  }

  private storeSetting(key: string, name: string, value: string): void {
    const settings = { ...this.state.nodeSettings[key], [name]: { value, at: this.now() } };
    this.set({ nodeSettings: { ...this.state.nodeSettings, [key]: settings } });
  }

  /** Drops what this client remembers about a node: its role, its status trend, the console. */
  forgetNode(key: string): void {
    const without = <T,>(record: Record<string, T>): Record<string, T> => {
      const copy = { ...record };
      delete copy[key];
      return copy;
    };
    this.set({
      logins: without(this.state.logins),
      statusHistory: without(this.state.statusHistory),
      statuses: without(this.state.statuses),
      neighbours: without(this.state.neighbours),
      accessLists: without(this.state.accessLists),
      ownerInfo: without(this.state.ownerInfo),
      nodeSettings: without(this.state.nodeSettings),
      consoles: without(this.state.consoles),
      series: without(this.state.series),
    });
  }

  clearConsole(key: string): void {
    const consoles = { ...this.state.consoles };
    delete consoles[key];
    this.set({ consoles });
  }

  /** Takes a request out of the queue before it goes on the air. One already out cannot be called back. */
  cancelRemote(id: string): void {
    const index = this.remoteQueue.findIndex((j) => j.info.id === id);
    if (index < 0) return;
    const [job] = this.remoteQueue.splice(index, 1);
    job!.reject(new Error("cancelled"));
    this.publishRemote();
  }

  private maskedTags = new Set<string>();

  private appendConsole(key: string, entry: ConsoleEntry): void {
    const prior = this.state.consoles[key] ?? [];
    const list = prior.length >= CONSOLE_LIMIT ? prior.slice(-CONSOLE_LIMIT + 1) : prior;
    this.set({ consoles: { ...this.state.consoles, [key]: [...list, entry] } });
  }

  private patchConsole(key: string, id: string, patch: Partial<ConsoleEntry>): void {
    const list = this.state.consoles[key];
    if (!list) return;
    this.set({ consoles: { ...this.state.consoles, [key]: list.map((e) => (e.id === id ? { ...e, ...patch } : e)) } });
  }

  /** A console reply: to the command waiting for it, to one that gave up on it, or a line of its own. */
  private receiveCli(prefix: string, text: string): void {
    const match = /^([0-9a-fA-F]{2})\|/.exec(text);
    const tag = match ? match[1]!.toLowerCase() : null;
    const body = match ? text.slice(3) : text;
    if (this.remoteEvent({ kind: "cli", prefix, tag, text: body })) return;
    const contact = this.contactByPrefix(prefix);
    const key = contact?.key ?? prefix;
    const masked = tag !== null && this.maskedTags.has(`${prefix}:${tag}`);
    const reply = masked ? maskReply(body) : body;
    const late = tag === null ? undefined : this.state.consoles[key]?.find((e) => e.tag === tag && e.status !== "done");
    if (late) {
      this.patchConsole(key, late.id, { status: "done", reply, repliedAt: this.now(), error: null });
      return;
    }
    this.appendConsole(key, { id: newId(this.now()), command: "", tag: tag ?? "", at: this.now(), status: "done", reply, repliedAt: this.now(), error: null });
  }

  private remoteRequest(
    key: string,
    label: string,
    start: RemoteJob["start"],
    answers: (event: RemoteEvent, sent: TextSendResult | null) => boolean,
    extraWaitMs = 0,
    onStart?: () => void,
  ): Promise<RemoteEvent> {
    if (!this.client || this.client.isClosed) return Promise.reject(new Error("not connected"));
    return new Promise((resolve, reject) => {
      this.jobCounter += 1;
      this.remoteQueue.push({
        info: { id: `r${this.jobCounter}`, key, label, startedAt: null },
        start: async (client) => {
          onStart?.();
          return start(client);
        },
        answers,
        extraWaitMs,
        sent: null,
        early: [],
        timer: null,
        resolve,
        reject,
      });
      this.publishRemote();
      void this.pumpRemote();
    });
  }

  private async pumpRemote(): Promise<void> {
    if (this.remoteActive) return;
    const job = this.remoteQueue.shift();
    if (!job) return;
    this.remoteActive = job;
    job.info = { ...job.info, startedAt: this.now() };
    this.publishRemote();
    const client = this.client;
    if (!client || client.isClosed) {
      this.finishRemote(job, new Error("not connected"));
      return;
    }
    try {
      const sent = await job.start(client);
      if (this.remoteActive !== job) return;
      job.sent = sent;
      const wait = this.replyWait(sent.estTimeoutMs, job.extraWaitMs);
      job.timer = setTimeout(() => this.finishRemote(job, new NoReplyError(job.info.label, wait)), wait);
      for (const event of job.early.splice(0)) this.remoteEvent(event);
    } catch (error) {
      this.finishRemote(job, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private finishRemote(job: RemoteJob, error: Error | null, event?: RemoteEvent): void {
    if (this.remoteActive !== job) return;
    this.remoteActive = null;
    if (job.timer) clearTimeout(job.timer);
    if (error) job.reject(error);
    else job.resolve(event!);
    this.publishRemote();
    void this.pumpRemote();
  }

  /** Hands a reply from a remote node to the request waiting for it; says whether one was. */
  private remoteEvent(event: RemoteEvent): boolean {
    const job = this.remoteActive;
    if (!job) return false;
    // A binary reply is known by the tag the radio gave when it sent the
    // request; one that overtakes that answer waits for it.
    if (!job.sent && event.kind === "binary") {
      job.early.push(event);
      return true;
    }
    if (!job.answers(event, job.sent)) return false;
    this.finishRemote(job, null, event);
    return true;
  }

  private publishRemote(): void {
    this.set({ remote: { active: this.remoteActive?.info ?? null, queued: this.remoteQueue.map((j) => j.info) } });
  }

  private dropRemoteJobs(reason: string): void {
    const jobs = [...(this.remoteActive ? [this.remoteActive] : []), ...this.remoteQueue];
    this.remoteActive = null;
    this.remoteQueue = [];
    for (const job of jobs) {
      if (job.timer) clearTimeout(job.timer);
      job.reject(new Error(reason));
    }
    this.publishRemote();
  }

  private noteStatus(key: string, contact: ContactRecord | null, raw: Uint8Array): void {
    // The tail differs between a repeater and a room, and only the contact says which answered.
    const stats = contact ? readNodeStats(raw, contact.type === AdvType.Room ? "room" : "repeater") : null;
    const at = this.now();
    const patch: Partial<SessionState> = { statuses: { ...this.state.statuses, [key]: { stats, raw: toHex(raw), at } } };
    if (stats) {
      const kept = (this.state.statusHistory[key] ?? []).filter((s) => at - s.at < HISTORY_MS);
      const history = [...kept, { at, batteryMv: stats.batteryMv, noiseFloor: stats.noiseFloor }].slice(-HISTORY_LIMIT);
      patch.statusHistory = { ...this.state.statusHistory, [key]: history };
    }
    this.set(patch);
  }

  // ---- pushes ----

  private onPush(frame: PushFrame): void {
    switch (frame.kind) {
      case "msgWaiting":
        if (this.isReady) this.syncMessages().catch((e: Error) => this.log("error", e.message));
        return;
      case "sendConfirmed": {
        const message = this.state.messages.find((m) => m.ackTag === frame.ackTag && m.direction === "out");
        if (message) {
          const timer = this.ackTimers.get(message.id);
          if (timer) clearTimeout(timer);
          this.ackTimers.delete(message.id);
          this.patchMessage(message.id, { status: "delivered", roundTripMs: frame.roundTripMs });
          // A flood's ack comes back inside the path the message took, and the
          // radio says it learned that path just before it says the ack came.
          const update = this.lastPathUpdate;
          if (message.flood && update && message.conversation === contactConversation(update.key) && this.now() - update.at < 5000) {
            void update.record.then((record) => {
              if (record) this.patchMessage(message.id, { route: contactRoute(record) });
            });
          }
        }
        return;
      }
      case "advert": {
        const key = toHex(frame.publicKey);
        const contact = this.state.contacts[key];
        if (contact) {
          this.set({
            contacts: {
              ...this.state.contacts,
              [key]: { ...contact, lastHeardAt: this.now(), lastAdvert: Math.floor(this.now() / 1000) },
            },
          });
        } else {
          this.queueContactsRefresh();
        }
        return;
      }
      case "newAdvert": {
        const record = this.upsertContact(frame.contact, true);
        this.log("advert", `new: ${record.name || record.prefix} (${contactTypeName(record.type)})`);
        for (const listener of this.discoveredListeners) {
          try {
            listener(record);
          } catch (error) {
            console.error("discovered listener threw", error);
          }
        }
        return;
      }
      case "pathUpdated": {
        const key = toHex(frame.publicKey);
        const client = this.client;
        if (!client) return;
        const at = this.now();
        const record = client
          .getContactByKey(frame.publicKey)
          .then((c) => this.upsertContact(c, false, at))
          .catch(() => {
            this.queueContactsRefresh();
            return null;
          });
        this.lastPathUpdate = { key, at, record };
        // A contact pinned to flood keeps no route, not even for the acks the
        // radio sends back to its messages.
        void record.then((r) => {
          if (r && r.outPathLen !== 0xff && isConversationType(r.type) && this.routePolicy(key).flood && this.client === client) {
            this.dropRoute(client, key, "flood pinned").catch((e: Error) => this.log("error", e.message));
          }
        });
        this.log("path", `route to ${this.state.contacts[key]?.name ?? key.slice(0, 12)} updated`);
        return;
      }
      case "contactDeleted": {
        const key = toHex(frame.publicKey);
        const contacts = { ...this.state.contacts };
        delete contacts[key];
        this.set({ contacts });
        this.log("contact", `radio dropped ${key.slice(0, 12)}: contacts full`);
        return;
      }
      case "contactsFull":
        this.log("contact", "the radio's contact table is full");
        return;
      case "loginSuccess":
      case "loginFail": {
        const prefix = toHex(frame.prefix);
        const contact = this.contactByPrefix(prefix);
        const key = contact?.key ?? prefix;
        const ok = frame.kind === "loginSuccess";
        const login: NodeLogin = ok
          ? {
              ok,
              role: frame.permissions === null ? null : frame.permissions & 3,
              serverTime: frame.serverTime,
              firmwareLevel: frame.firmwareLevel,
              at: this.now(),
            }
          : { ok, role: null, serverTime: null, firmwareLevel: null, at: this.now() };
        this.set({ logins: { ...this.state.logins, [key]: login } });
        this.log("login", `${contact?.name ?? prefix}: ${ok ? `signed in${login.role === null ? "" : ` as ${aclRoleName(login.role)}`}` : "password refused"}`);
        this.remoteEvent({ kind: "login", prefix, ok });
        return;
      }
      case "statusResponse": {
        const prefix = toHex(frame.prefix);
        const contact = this.contactByPrefix(prefix);
        this.noteStatus(contact?.key ?? prefix, contact, frame.raw);
        this.log("status", `${contact?.name ?? prefix}: status received`);
        this.remoteEvent({ kind: "status", prefix });
        return;
      }
      case "telemetryResponse": {
        const prefix = toHex(frame.prefix);
        const contact = this.contactByPrefix(prefix);
        const key = this.state.self?.prefix === prefix ? "self" : (contact?.key ?? prefix);
        this.set({ telemetry: { ...this.state.telemetry, [key]: { readings: frame.readings, at: this.now() } } });
        this.log("telemetry", `${key === "self" ? "this radio" : (contact?.name ?? prefix)}: ${frame.readings.length} reading(s)`);
        if (key !== "self") this.remoteEvent({ kind: "telemetry", prefix, readings: frame.readings });
        return;
      }
      case "pathDiscoveryResponse": {
        const prefix = toHex(frame.prefix);
        const contact = this.contactByPrefix(prefix);
        this.log(
          "path",
          `${contact?.name ?? prefix}: out ${frame.outPathLen & 63} hop(s) ${toHex(frame.outPath)}, in ${frame.inPathLen & 63} hop(s) ${toHex(frame.inPath)}`,
        );
        this.remoteEvent({ kind: "path", prefix });
        return;
      }
      case "traceData": {
        const waiter = this.traceWaiters.get(frame.tag);
        if (waiter) waiter(frame);
        else this.log("trace", `tag ${frame.tag.toString(16)}: ${toHex(frame.hashes)} snr ${frame.snrs.map((s) => s.toFixed(1)).join("/")}`);
        return;
      }
      case "binaryResponse":
        this.log("binary", `tag ${frame.tag.toString(16)}: ${frame.data.length} byte(s)`);
        this.remoteEvent({ kind: "binary", tag: frame.tag, data: frame.data });
        return;
      case "rawData":
        this.log("raw", `snr ${frame.snr} rssi ${frame.rssi}: ${toHex(frame.payload)}`);
        return;
      case "logRxData": {
        this.log("rx", `snr ${frame.snr} rssi ${frame.rssi}: ${toHex(frame.raw)}`);
        this.noteHeard(frame.snr, frame.raw);
        if (this.heardListeners.size === 0) return;
        const heard: HeardPacket = { at: this.now(), snr: frame.snr, rssi: frame.rssi, size: frame.raw.length, packet: parseRawPacket(frame.raw) };
        for (const listener of this.heardListeners) {
          try {
            listener(heard);
          } catch (error) {
            console.error("heard listener threw", error);
          }
        }
        return;
      }
      case "controlData":
        this.log("control", `snr ${frame.snr} rssi ${frame.rssi}: ${toHex(frame.payload)}`);
        for (const listener of this.controlListeners) listener(frame);
        return;
    }
  }
}

/** A console reply with a password in it, as the console shows it. */
function maskReply(reply: string): string {
  return reply.replace(/^(password now:\s*).*$/is, "$1••••••");
}

/** Whether `a` and `b` name the same radio. */
export function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  return bytesEqual(a, b);
}
