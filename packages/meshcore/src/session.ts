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
import { AdvType, ContactFlag, MAX_TEXT_LEN, PUB_KEY_PREFIX_SIZE, TxtType } from "./protocol/codes.js";
import type { OtherParams, RadioParams } from "./protocol/commands.js";
import type { Contact, DeviceInfo, PushFrame, RepeaterStats, SelfInfo } from "./protocol/frames.js";
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
}

export interface LogEntry {
  at: number;
  kind: string;
  text: string;
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
  logins: Record<string, { permissions: number; ok: boolean; at: number }>;
  telemetry: Record<string, { readings: LppReading[]; at: number }>;
  statuses: Record<string, { stats: RepeaterStats | null; raw: string; at: number }>;
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
  log: [],
  error: null,
  syncing: false,
};

export class MeshSession {
  private state: SessionState = EMPTY;
  private listeners = new Set<() => void>();
  private client: MeshCoreClient | null = null;
  private readonly appName: string;
  private readonly storage: SessionStorage | null;
  private readonly now: () => number;
  private readonly trace: SessionOptions["trace"];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private syncQueued = false;
  private contactsRefreshQueued = false;
  private focused: string | null = null;
  private ackTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: SessionOptions = {}) {
    this.appName = options.appName ?? "Meshnet";
    this.storage = options.storage ?? null;
    this.now = options.now ?? (() => Date.now());
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
      "unread" in patch
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
    const { contacts, contactsCursor, channels, messages, unread } = this.state;
    try {
      await this.storage.save(this.state.self.key, { contacts, contactsCursor, channels, messages, unread });
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
        // byte; the low six bits are the hops either way.
        messages: (persisted?.messages ?? []).map((m) => (m.hops === null ? m : { ...m, hops: m.hops & 63 })),
        unread: persisted?.unread ?? {},
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
      return { ...m, conversation: contactConversation(contact.key), sender: contact.name };
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
      const contact = this.contactByPrefix(prefix);
      if (!contact) this.queueContactsRefresh();
      message = {
        id: newId(now),
        conversation: contact ? contactConversation(contact.key) : `p:${prefix}`,
        direction: "in",
        text: frame.text,
        sender: contact?.name ?? null,
        senderPrefix: prefix,
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

  // ---- repeaters and rooms ----

  async login(key: string, password: string): Promise<void> {
    await this.need().sendLogin(this.contactBytes(key), password);
  }

  async logout(key: string): Promise<void> {
    await this.need().logout(this.contactBytes(key));
    const logins = { ...this.state.logins };
    delete logins[key];
    this.set({ logins });
  }

  async requestStatus(key: string): Promise<void> {
    await this.need().sendStatusReq(this.contactBytes(key));
  }

  async requestTelemetry(key?: string): Promise<void> {
    await this.need().sendTelemetryReq(key ? this.contactBytes(key) : undefined);
  }

  async discoverPath(key: string): Promise<void> {
    await this.need().sendPathDiscoveryReq(this.contactBytes(key));
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
        this.set({
          logins: { ...this.state.logins, [key]: { permissions: ok ? frame.permissions : 0, ok, at: this.now() } },
        });
        this.log("login", `${contact?.name ?? prefix}: ${ok ? "logged in" : "login refused"}`);
        return;
      }
      case "statusResponse": {
        const prefix = toHex(frame.prefix);
        const contact = this.contactByPrefix(prefix);
        const key = contact?.key ?? prefix;
        this.set({ statuses: { ...this.state.statuses, [key]: { stats: frame.stats, raw: toHex(frame.raw), at: this.now() } } });
        this.log("status", `${contact?.name ?? prefix}: status received`);
        return;
      }
      case "telemetryResponse": {
        const prefix = toHex(frame.prefix);
        const contact = this.contactByPrefix(prefix);
        const key = this.state.self?.prefix === prefix ? "self" : (contact?.key ?? prefix);
        this.set({ telemetry: { ...this.state.telemetry, [key]: { readings: frame.readings, at: this.now() } } });
        this.log("telemetry", `${key === "self" ? "this radio" : (contact?.name ?? prefix)}: ${frame.readings.length} reading(s)`);
        return;
      }
      case "pathDiscoveryResponse": {
        const prefix = toHex(frame.prefix);
        const contact = this.contactByPrefix(prefix);
        this.log(
          "path",
          `${contact?.name ?? prefix}: out ${frame.outPathLen & 63} hop(s) ${toHex(frame.outPath)}, in ${frame.inPathLen & 63} hop(s) ${toHex(frame.inPath)}`,
        );
        return;
      }
      case "traceData":
        this.log("trace", `tag ${frame.tag.toString(16)}: ${toHex(frame.hashes)} snr ${frame.snrs.map((s) => s.toFixed(1)).join("/")}`);
        return;
      case "binaryResponse":
        this.log("binary", `tag ${frame.tag.toString(16)}: ${toHex(frame.data)}`);
        return;
      case "rawData":
        this.log("raw", `snr ${frame.snr} rssi ${frame.rssi}: ${toHex(frame.payload)}`);
        return;
      case "logRxData":
        this.log("rx", `snr ${frame.snr} rssi ${frame.rssi}: ${toHex(frame.raw)}`);
        return;
      case "controlData":
        this.log("control", `snr ${frame.snr} rssi ${frame.rssi}: ${toHex(frame.payload)}`);
        return;
    }
  }
}

/** Whether `a` and `b` name the same radio. */
export function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  return bytesEqual(a, b);
}
