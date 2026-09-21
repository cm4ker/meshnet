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

import { MeshCoreClient, MeshCoreError, type TextSendResult } from "./client.js";
import { bytesEqual, fromHex, toHex, unixNow } from "./protocol/bytes.js";
import { groupTextPayload } from "./protocol/group.js";
import { PayloadType, parseRawPacket } from "./protocol/packet.js";
import { AclRole, AdvType, ContactFlag, MAX_TEXT_LEN, PUB_KEY_PREFIX_SIZE, TxtType } from "./protocol/codes.js";
import {
  accessListRequest,
  avgMinMaxRequest,
  neighboursRequest,
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
}

export interface ChannelRecord {
  index: number;
  name: string;
  /** Hex of the 16-byte secret. */
  secret: string;
}

export type MessageStatus = "sending" | "sent" | "delivered" | "unconfirmed" | "failed";

/** A copy of one of our channel messages the radio overheard on its way through the mesh. */
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
  /** Copies heard back from repeaters, one per distinct path. Empty for incoming messages. */
  echoes: MessageEcho[];
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

function toRecord(contact: Contact, lastHeardAt: number | null): ContactRecord {
  const key = toHex(contact.publicKey);
  return {
    key,
    prefix: key.slice(0, PUB_KEY_PREFIX_SIZE * 2),
    type: contact.type,
    flags: contact.flags,
    outPathLen: contact.outPathLen,
    outPath: toHex(contact.outPath),
    name: contact.name,
    lastAdvert: contact.lastAdvert,
    lat: contact.lat,
    lon: contact.lon,
    lastMod: contact.lastMod,
    lastHeardAt,
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
  log: [],
  error: null,
  syncing: false,
};

/** How long after sending a channel message its echoes are still looked for. */
const ECHO_WINDOW_MS = 15 * 60 * 1000;

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
  private client: MeshCoreClient | null = null;
  private readonly appName: string;
  private readonly storage: SessionStorage | null;
  private readonly now: () => number;
  private readonly replyWait: (estimateMs: number, extraMs: number) => number;
  private readonly trace: SessionOptions["trace"];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private syncQueued = false;
  private contactsRefreshQueued = false;
  private focused: string | null = null;
  private ackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** What our recent channel messages look like on the air (payload hex), to know their echoes by. */
  private echoWatch = new Map<string, { id: string; at: number }>();
  private remoteQueue: RemoteJob[] = [];
  private remoteActive: RemoteJob | null = null;
  private jobCounter = 0;
  /** The next console tag; two hex digits, so the node's `XX|` rule holds. */
  private cliTag = Math.floor(Math.random() * 256);

  constructor(options: SessionOptions = {}) {
    this.appName = options.appName ?? "Meshnet";
    this.storage = options.storage ?? null;
    this.now = options.now ?? (() => Date.now());
    this.replyWait = options.replyWaitMs ?? replyWaitMs;
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
      "statusHistory" in patch
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

  private async saveNow(): Promise<void> {
    if (!this.storage || !this.state.self) return;
    const { contacts, contactsCursor, channels, messages, unread, logins, statusHistory } = this.state;
    try {
      await this.storage.save(this.state.self.key, { contacts, contactsCursor, channels, messages, unread, logins, statusHistory });
    } catch (error) {
      this.log("error", `could not save: ${(error as Error).message}`);
    }
  }

  // ---- connecting ----

  get isReady(): boolean {
    return this.state.status === "ready" && this.client !== null;
  }

  private need(): MeshCoreClient {
    if (!this.client || this.client.isClosed) throw new Error("not connected");
    return this.client;
  }

  async connect(transport: Transport): Promise<void> {
    if (this.client) await this.disconnect();
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
      this.set({
        device,
        self,
        contacts: persisted?.contacts ?? {},
        contactsCursor: persisted?.contactsCursor ?? 0,
        channels: persisted?.channels ?? [],
        // History saved before the hop count was masked holds the raw path_len
        // byte (the low six bits are the hops either way), and history saved
        // before echoes were kept has none.
        messages: (persisted?.messages ?? []).map((m) => ({ ...m, hops: m.hops === null ? null : m.hops & 63, echoes: m.echoes ?? [] })),
        unread: persisted?.unread ?? {},
        logins: persisted?.logins ?? {},
        statusHistory: persisted?.statusHistory ?? {},
      });
      this.log("link", `connected to ${self.name} (${device.firmwareVersion})`);

      await this.syncClock();
      await this.refreshContacts();
      await this.refreshChannels();
      this.set({ status: "ready" });
      await this.syncMessages();
      void this.refreshBattery();
    } catch (error) {
      const message = (error as Error).message;
      this.set({ error: message });
      this.log("error", `connect failed: ${message}`);
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
    for (const c of fresh) {
      const record = toRecord(c, contacts[toHex(c.publicKey)]?.lastHeardAt ?? null);
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
    for (const c of fresh) {
      const key = toHex(c.publicKey);
      contacts[key] = toRecord(c, this.state.contacts[key]?.lastHeardAt ?? null);
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

  private upsertContact(contact: Contact, heard: boolean): ContactRecord {
    const key = toHex(contact.publicKey);
    const record = toRecord(contact, heard ? this.now() : (this.state.contacts[key]?.lastHeardAt ?? null));
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
    await this.need().resetPath(this.contactBytes(key));
    const contact = this.state.contacts[key]!;
    this.set({ contacts: { ...this.state.contacts, [key]: { ...contact, outPathLen: 0xff } } });
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
    try {
      do {
        this.syncQueued = false;
        for (;;) {
          const frame = await client.syncNextMessage();
          if (!frame) break;
          this.receive(frame);
        }
      } while (this.syncQueued);
    } finally {
      this.set({ syncing: false });
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
  }

  private patchMessage(id: string, patch: Partial<MessageRecord>): void {
    const messages = this.state.messages.map((m) => (m.id === id ? { ...m, ...patch } : m));
    this.set({ messages });
  }

  /** Sends text to a conversation and records it; the record's status follows the ack. */
  async sendText(conversation: string, text: string): Promise<MessageRecord> {
    const client = this.need();
    const target = parseConversation(conversation);
    if (target.kind === "prefix") throw new Error("this sender is not in the contacts yet");
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
      status: "sending",
      ackTag: null,
      roundTripMs: null,
      flood: null,
      attempt: 0,
      error: null,
      echoes: [],
    };
    this.set({ messages: [...this.state.messages, message] });
    await this.transmit(client, message, target);
    return this.state.messages.find((m) => m.id === message.id) ?? message;
  }

  /** Sends an unconfirmed or failed message again, one attempt up. */
  async retry(id: string): Promise<void> {
    const message = this.state.messages.find((m) => m.id === id);
    if (!message || message.direction !== "out") throw new Error("not an outgoing message");
    const client = this.need();
    const attempt = message.attempt + 1;
    this.patchMessage(id, { status: "sending", error: null, attempt, ackTag: null, roundTripMs: null });
    await this.transmit(client, { ...message, attempt }, parseConversation(message.conversation));
  }

  private async transmit(
    client: MeshCoreClient,
    message: MessageRecord,
    target: ReturnType<typeof parseConversation>,
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
      const result = await client.sendTextMessage(fromHex(contact.prefix), message.text, {
        attempt: message.attempt,
        timestamp: message.timestamp,
      });
      this.armAck(message.id, result);
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
      for (const [key, watch] of this.echoWatch) if (now - watch.at > ECHO_WINDOW_MS) this.echoWatch.delete(key);
      this.echoWatch.set(toHex(payload), { id: message.id, at: now });
    } catch (error) {
      this.log("echo", `cannot work out the payload: ${(error as Error).message}`);
    }
  }

  /** A packet the radio heard that is one of our channel messages coming back: its path says who relayed it. */
  private noteEcho(snr: number, raw: Uint8Array): void {
    if (this.echoWatch.size === 0) return;
    const packet = parseRawPacket(raw);
    if (!packet || !packet.flood || packet.payloadType !== PayloadType.GroupText || packet.path.length === 0) return;
    const watch = this.echoWatch.get(toHex(packet.payload));
    if (!watch) return;
    const message = this.state.messages.find((m) => m.id === watch.id);
    if (!message) return;
    const key = packet.path.join(",");
    if (message.echoes.some((e) => e.path.join(",") === key)) return;
    this.patchMessage(message.id, { echoes: [...message.echoes, { path: packet.path, snr }] });
  }

  private armAck(id: string, result: TextSendResult): void {
    if (result.ackTag === 0) {
      this.patchMessage(id, { status: "sent", flood: result.flood, ackTag: null });
      return;
    }
    this.patchMessage(id, { status: "sent", flood: result.flood, ackTag: result.ackTag });
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
        return;
      }
      case "pathUpdated": {
        const key = toHex(frame.publicKey);
        const client = this.client;
        if (!client) return;
        client
          .getContactByKey(frame.publicKey)
          .then((c) => this.upsertContact(c, false))
          .catch(() => this.queueContactsRefresh());
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
      case "traceData":
        this.log("trace", `tag ${frame.tag.toString(16)}: ${toHex(frame.hashes)} snr ${frame.snrs.map((s) => s.toFixed(1)).join("/")}`);
        return;
      case "binaryResponse":
        this.log("binary", `tag ${frame.tag.toString(16)}: ${frame.data.length} byte(s)`);
        this.remoteEvent({ kind: "binary", tag: frame.tag, data: frame.data });
        return;
      case "rawData":
        this.log("raw", `snr ${frame.snr} rssi ${frame.rssi}: ${toHex(frame.payload)}`);
        return;
      case "logRxData":
        this.log("rx", `snr ${frame.snr} rssi ${frame.rssi}: ${toHex(frame.raw)}`);
        this.noteEcho(frame.snr, frame.raw);
        return;
      case "controlData":
        this.log("control", `snr ${frame.snr} rssi ${frame.rssi}: ${toHex(frame.payload)}`);
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
