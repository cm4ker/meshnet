import { useEffect, useState, useSyncExternalStore } from "react";
import { AdvertLocPolicy, TelemMode, type SessionState } from "@meshnet/meshcore";
import { bandwidth, frequency } from "../lib/format.js";
import { disconnect } from "../lib/link.js";
import { setLookalikePrefs, useLookalikePrefs } from "../lib/lookalikes.js";
import type { RadioPage } from "../lib/nav.js";
import { askPermission, nodeNotificationsWanted, notificationsWanted, setNodeNotificationsWanted, setNotificationsWanted } from "../lib/notify.js";
import { shell } from "../lib/platform.js";
import { limitLabel, limitValue, parseLimit, ROUTE_LIMITS } from "../lib/routes.js";
import { session, storage, useSession } from "../lib/session.js";
import { act, toast } from "../lib/toast.js";
import { getPreference, listThemes, setPreference, subscribeTheme } from "../theme/store.js";
import { getSystemTextScale, getTextScale, getTextSizePreference, hasSystemTextSize, setTextSizePreference, subscribeTextSize, TEXT_STEPS } from "../theme/textSize.js";
import { autoConnectWanted, setAutoConnect } from "../transports/index.js";
import { Button } from "../ui/Button.js";
import { Confirm } from "../ui/Dialog.js";
import { ActionRow, Block, Group, InfoRow, LinkRow, SelectRow, SwitchRow } from "../ui/List.js";
import { CopyIcon } from "./Icons.js";
import { LogView } from "./LogView.js";
import { Readings } from "./Readings.js";
import { ScreenHead, type Chrome } from "./ScreenHead.js";

type Self = NonNullable<SessionState["self"]>;

export const RADIO_TITLES: Record<RadioPage, string> = {
  name: "Name and position",
  frequency: "Frequency and power",
  privacy: "Privacy and telemetry",
  advanced: "Advanced",
  notifications: "Notifications",
  messages: "Messages and routes",
  appearance: "Appearance",
  connection: "Connection",
  log: "Log",
  power: "Reboot, reset, erase",
  about: "About",
};

interface Preset {
  name: string;
  frequencyKhz: number;
  bandwidthHz: number;
  spreadingFactor: number;
  codingRate: number;
}

const PRESETS: Preset[] = [
  { name: "EU/UK", frequencyKhz: 869_525, bandwidthHz: 250_000, spreadingFactor: 11, codingRate: 5 },
  { name: "EU narrow", frequencyKhz: 869_618, bandwidthHz: 62_500, spreadingFactor: 8, codingRate: 8 },
  { name: "US", frequencyKhz: 910_525, bandwidthHz: 62_500, spreadingFactor: 7, codingRate: 5 },
  { name: "ANZ", frequencyKhz: 915_800, bandwidthHz: 250_000, spreadingFactor: 10, codingRate: 5 },
  { name: "PKIO", frequencyKhz: 869_161, bandwidthHz: 62_500, spreadingFactor: 7, codingRate: 7 },
];

const BANDWIDTHS = ["7.8", "10.4", "15.6", "20.8", "31.25", "41.7", "62.5", "125", "250", "500"];

/** The preset the radio is on, or its frequency and spreading factor when it is on none. */
export function presetName(self: Self): string {
  const p = PRESETS.find((q) => q.frequencyKhz === self.frequencyKhz && q.bandwidthHz === self.bandwidthHz && q.spreadingFactor === self.spreadingFactor && q.codingRate === self.codingRate);
  return p ? p.name : `${(self.frequencyKhz / 1000).toFixed(3)} · SF${self.spreadingFactor}`;
}

const TELEMETRY = [
  { value: String(TelemMode.Deny), label: "Nobody" },
  { value: String(TelemMode.AllowFlags), label: "Contacts marked for it" },
  { value: String(TelemMode.AllowAll), label: "Anyone" },
];

/** The rest of the radio's settings go in one command, so a change to one sends all of them as they are. */
function saveOther(self: Self, patch: Partial<Pick<Self, "manualAddContacts" | "telemetryModeBase" | "telemetryModeLocation" | "telemetryModeEnvironment" | "advertLocPolicy" | "multiAcks">>) {
  return act(
    () =>
      session.setOtherParams({
        manualAddContacts: patch.manualAddContacts ?? self.manualAddContacts,
        telemetryModeBase: patch.telemetryModeBase ?? self.telemetryModeBase,
        telemetryModeLocation: patch.telemetryModeLocation ?? self.telemetryModeLocation,
        telemetryModeEnvironment: patch.telemetryModeEnvironment ?? self.telemetryModeEnvironment,
        advertLocPolicy: patch.advertLocPolicy ?? self.advertLocPolicy,
        multiAcks: patch.multiAcks ?? self.multiAcks,
      }),
    "Saved to the radio",
  );
}

/**
 * A text field that saves itself when it is left or Enter is pressed, if it
 * changed and reads right. Nothing to press; the toast says it was saved.
 */
function CommitField({ label, hint, value, onCommit, check, disabled, inputMode, maxLength, mono }: { label: string; hint?: string | undefined; value: string; onCommit: (text: string) => Promise<unknown>; check?: (text: string) => string | null; disabled?: boolean | undefined; inputMode?: "decimal" | "numeric" | "text" | undefined; maxLength?: number | undefined; mono?: boolean | undefined }) {
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    if (text.trim() === value) return setError(null);
    const problem = check?.(text.trim()) ?? null;
    setError(problem);
    if (problem) return;
    void act(() => onCommit(text.trim()), "Saved to the radio").then((ok) => ok || setText(value));
  };
  return (
    <Block>
      <label className="field">
        <span className="field-label">{label}</span>
        <input
          className={["input", mono ? "mono" : ""].join(" ")}
          value={text}
          disabled={disabled}
          inputMode={inputMode}
          maxLength={maxLength}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
            if (e.key === "Escape") setText(value);
          }}
        />
        {error ? <span className="field-hint danger">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
      </label>
    </Block>
  );
}

const number = (min: number, max: number, what: string) => (text: string) => {
  const n = Number(text);
  return Number.isFinite(n) && text !== "" && n >= min && n <= max ? null : `${what} is between ${min} and ${max}.`;
};

export function RadioPageView({ page, chrome }: { page: RadioPage; chrome: Chrome }) {
  return (
    <div className="screen">
      <ScreenHead chrome={chrome}>
        <span className="screen-name">{RADIO_TITLES[page]}</span>
      </ScreenHead>
      {page === "log" ? <LogView /> : <div className="screen-scroll">{<PageBody page={page} />}</div>}
    </div>
  );
}

function PageBody({ page }: { page: RadioPage }) {
  const state = useSession();
  const self = state.self;
  const online = state.status === "ready";
  switch (page) {
    case "name":
      return self ? <NamePage self={self} online={online} /> : <Offline />;
    case "frequency":
      return self ? <FrequencyPage self={self} online={online} /> : <Offline />;
    case "privacy":
      return self ? (
        <>
          <Group note="Whether radios heard advertising join the contacts by themselves.">
            <SelectRow
              label="New contacts"
              value={String(self.manualAddContacts & 1)}
              disabled={!online}
              options={[
                { value: "0", label: "Add automatically" },
                { value: "1", label: "Only when I add them" },
              ]}
              onChange={(v) => void saveOther(self, { manualAddContacts: (self.manualAddContacts & ~1) | Number(v) })}
            />
          </Group>
          <Group title="Who may read its telemetry">
            <SelectRow label="Battery" value={String(self.telemetryModeBase)} options={TELEMETRY} disabled={!online} onChange={(v) => void saveOther(self, { telemetryModeBase: Number(v) })} />
            <SelectRow label="Location" value={String(self.telemetryModeLocation)} options={TELEMETRY} disabled={!online} onChange={(v) => void saveOther(self, { telemetryModeLocation: Number(v) })} />
            <SelectRow label="Sensors" value={String(self.telemetryModeEnvironment)} options={TELEMETRY} disabled={!online} onChange={(v) => void saveOther(self, { telemetryModeEnvironment: Number(v) })} />
          </Group>
        </>
      ) : (
        <Offline />
      );
    case "advanced":
      return self ? <AdvancedPage self={self} online={online} /> : <Offline />;
    case "notifications":
      return <NotificationsPage />;
    case "messages":
      return <MessagesPage />;
    case "appearance":
      return <AppearancePage />;
    case "connection":
      return <ConnectionPage />;
    case "power":
      return <PowerPage />;
    case "about":
      return (
        <Group note="A companion for MeshCore radios. Messages stay on this device; the radio keeps only what has not been read yet.">
          <InfoRow label="Meshnet">{__APP_VERSION__}</InfoRow>
          <InfoRow label="Running in">{shell() === "tauri" ? "the desktop shell" : shell() === "capacitor" ? "the phone shell" : "a browser"}</InfoRow>
        </Group>
      );
    default:
      return null;
  }
}

function Offline() {
  return <div className="empty muted">Connect to the radio to see this.</div>;
}

function NamePage({ self, online }: { self: Self; online: boolean }) {
  const locate = () => {
    navigator.geolocation?.getCurrentPosition(
      (pos) => void act(() => session.setLocation(Number(pos.coords.latitude.toFixed(6)), Number(pos.coords.longitude.toFixed(6))), "Position taken from this device"),
      (error) => toast(error.message || "This device would not say where it is", "error"),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };
  return (
    <>
      <Group>
        <CommitField label="Name" hint="Other radios see it in adverts and before your channel messages." value={self.name} maxLength={31} disabled={!online} onCommit={(name) => session.setName(name)} check={(t) => (t ? null : "A name cannot be empty.")} />
      </Group>
      <Group title="Position">
        <CommitField label="Latitude" value={String(self.lat)} inputMode="decimal" disabled={!online} check={number(-90, 90, "Latitude")} onCommit={(t) => session.setLocation(Number(t), self.lon)} />
        <CommitField label="Longitude" value={String(self.lon)} inputMode="decimal" disabled={!online} check={number(-180, 180, "Longitude")} onCommit={(t) => session.setLocation(self.lat, Number(t))} />
        {"geolocation" in navigator ? <ActionRow label="Use this device's position" disabled={!online} onClick={locate} /> : null}
        <SwitchRow
          label="Share it in adverts"
          hint="Others see this radio on their map."
          checked={self.advertLocPolicy !== AdvertLocPolicy.None}
          disabled={!online}
          onChange={(v) => void saveOther(self, { advertLocPolicy: v ? AdvertLocPolicy.Share : AdvertLocPolicy.None })}
        />
      </Group>
    </>
  );
}

function FrequencyPage({ self, online }: { self: Self; online: boolean }) {
  const initial = () => ({ frequency: (self.frequencyKhz / 1000).toFixed(3), bandwidth: (self.bandwidthHz / 1000).toString(), sf: String(self.spreadingFactor), cr: String(self.codingRate), tx: String(self.txPower) });
  const [values, setValues] = useState(initial);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const now = initial();
  const dirty = JSON.stringify(values) !== JSON.stringify(now);
  // What the radio reports wins while nothing here was touched.
  useEffect(() => {
    if (!dirty) setValues(initial());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [self.frequencyKhz, self.bandwidthHz, self.spreadingFactor, self.codingRate, self.txPower]);
  const update = (patch: Partial<typeof values>) => setValues((v) => ({ ...v, ...patch }));
  const freq = Number(values.frequency);
  const tx = Number(values.tx);
  const valid = Number.isFinite(freq) && freq >= 150 && freq <= 2500 && Number.isInteger(tx) && tx >= -9 && tx <= self.maxTxPower;

  const apply = async () => {
    setBusy(true);
    const ok = await act(async () => {
      await session.setRadioParams({ frequencyKhz: Math.round(freq * 1000), bandwidthHz: Math.round(Number(values.bandwidth) * 1000), spreadingFactor: Number(values.sf), codingRate: Number(values.cr) });
      if (tx !== self.txPower) await session.setTxPower(tx);
    }, "Radio settings applied");
    setBusy(false);
    setAsking(false);
    if (!ok) setValues(initial());
  };

  return (
    <>
      <Group title="Preset">
        <Block>
          <div className="preset-chips">
            {PRESETS.map((p) => {
              const on = Math.round(freq * 1000) === p.frequencyKhz && Math.round(Number(values.bandwidth) * 1000) === p.bandwidthHz && Number(values.sf) === p.spreadingFactor && Number(values.cr) === p.codingRate;
              return (
                <button
                  key={p.name}
                  type="button"
                  className={["chip", on ? "on" : ""].join(" ")}
                  disabled={!online}
                  onClick={() => update({ frequency: (p.frequencyKhz / 1000).toFixed(3), bandwidth: (p.bandwidthHz / 1000).toString(), sf: String(p.spreadingFactor), cr: String(p.codingRate) })}
                >
                  {p.name} <span className="muted">{(p.frequencyKhz / 1000).toFixed(3)}</span>
                </button>
              );
            })}
          </div>
        </Block>
      </Group>
      <Group title="Values">
        <Block>
          <div className="form-grid">
            <label className="field">
              <span className="field-label">Frequency, MHz</span>
              <input className="input mono" inputMode="decimal" value={values.frequency} disabled={!online} onChange={(e) => update({ frequency: e.target.value })} />
            </label>
            <label className="field">
              <span className="field-label">Bandwidth, kHz</span>
              <select className="input select" value={values.bandwidth} disabled={!online} onChange={(e) => update({ bandwidth: e.target.value })}>
                {BANDWIDTHS.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Spreading factor</span>
              <select className="input select" value={values.sf} disabled={!online} onChange={(e) => update({ sf: e.target.value })}>
                {[5, 6, 7, 8, 9, 10, 11, 12].map((n) => (
                  <option key={n} value={n}>
                    SF{n}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Coding rate</span>
              <select className="input select" value={values.cr} disabled={!online} onChange={(e) => update({ cr: e.target.value })}>
                {[5, 6, 7, 8].map((n) => (
                  <option key={n} value={n}>
                    4/{n}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Transmit power, dBm (up to {self.maxTxPower})</span>
              <input className="input mono" type="number" min={-9} max={self.maxTxPower} value={values.tx} disabled={!online} onChange={(e) => update({ tx: e.target.value })} />
            </label>
          </div>
        </Block>
      </Group>
      <p className="group-note">
        Now {frequency(self.frequencyKhz)}, {bandwidth(self.bandwidthHz)}, SF{self.spreadingFactor}, CR 4/{self.codingRate}, {self.txPower} dBm. Every radio on a mesh must match: a radio on other settings stops hearing this one.
      </p>
      <div className="page-actions">
        {dirty ? <Button onClick={() => setValues(initial())}>Revert</Button> : null}
        <Button variant="primary" size="lg" disabled={!dirty || !valid || !online} busy={busy} onClick={() => setAsking(true)}>
          Apply
        </Button>
      </div>
      <Confirm
        open={asking}
        title="Change the radio's settings?"
        body={<p>Radios still on the old settings stop hearing this one until they change too.</p>}
        confirmLabel="Apply"
        onCancel={() => setAsking(false)}
        onConfirm={apply}
      />
    </>
  );
}

function AdvancedPage({ self, online }: { self: Self; online: boolean }) {
  const state = useSession();
  const device = state.device;
  useEffect(() => {
    if (online && !state.tuning) void session.refreshTuning().catch(() => undefined);
  }, [online, state.tuning]);
  const own = state.telemetry["self"];
  return (
    <>
      <Group title="Device">
        {device ? (
          <>
            <InfoRow label="Firmware">
              {device.firmwareVersion} · {device.buildDate} · protocol {device.firmwareVerCode}
            </InfoRow>
            <InfoRow label="Board">{device.manufacturer}</InfoRow>
            <InfoRow label="Capacity">
              {device.maxContacts} contacts · {device.maxChannels} channels
            </InfoRow>
            {device.blePin ? (
              <InfoRow label="Bluetooth PIN" mono>
                {String(device.blePin).padStart(6, "0")}
              </InfoRow>
            ) : null}
          </>
        ) : null}
        <LinkRow label="Public key" value={<span className="mono">{self.key.slice(0, 16)}…</span>} trailing={<CopyIcon size={14} className="line-chev" />} onClick={() => void navigator.clipboard?.writeText(self.key).then(() => toast("Copied"))} />
      </Group>
      <Group title="Clock and sensors">
        <ActionRow label="Set the radio's clock from this device" disabled={!online} onClick={() => void act(() => session.syncClock(), "Clock set")} />
        <ActionRow label="Read the radio's own sensors" disabled={!online} onClick={() => void act(() => session.requestTelemetry())} />
        {own ? <Readings readings={own.readings} /> : null}
      </Group>
      <Group title="Tuning">
        <SelectRow
          label="Extra acknowledgements"
          hint="Repeats of each ack, for lossy links."
          value={String(self.multiAcks)}
          disabled={!online}
          options={[0, 1, 2, 3].map((n) => ({ value: String(n), label: String(n) }))}
          onChange={(v) => void saveOther(self, { multiAcks: Number(v) })}
        />
        <CommitField
          label="Receive delay base"
          hint="0 turns the receive back-off off."
          value={String(state.tuning?.rxDelayBase ?? 0)}
          inputMode="decimal"
          disabled={!online || !state.tuning}
          check={number(0, 20, "The delay base")}
          onCommit={(t) => session.setTuning(Number(t), state.tuning?.airtimeFactor ?? 0)}
        />
        <CommitField
          label="Airtime factor"
          hint="How much the radio holds back after sending."
          value={String(state.tuning?.airtimeFactor ?? 0)}
          inputMode="decimal"
          disabled={!online || !state.tuning}
          check={number(0, 9, "The airtime factor")}
          onCommit={(t) => session.setTuning(state.tuning?.rxDelayBase ?? 0, Number(t))}
        />
      </Group>
    </>
  );
}

function NotificationsPage() {
  const [messages, setMessages] = useState(notificationsWanted);
  const [nodes, setNodes] = useState(nodeNotificationsWanted);
  return (
    <Group note="System notifications while the window is elsewhere. A tap opens the chat or the node.">
      <SwitchRow
        label="Messages"
        hint="For a chat you are not looking at."
        checked={messages}
        onChange={async (v) => {
          if (v && !(await askPermission())) return toast("Notifications are turned off for this app in the system's settings", "error");
          setMessages(v);
          setNotificationsWanted(v);
        }}
      />
      <SwitchRow
        label="New nodes"
        hint="When the radio hears a node for the first time."
        checked={nodes}
        onChange={async (v) => {
          if (v && !(await askPermission())) return toast("Notifications are turned off for this app in the system's settings", "error");
          setNodes(v);
          setNodeNotificationsWanted(v);
        }}
      />
    </Group>
  );
}

function MessagesPage() {
  const state = useSession();
  const lookalikes = useLookalikePrefs();
  return (
    <>
      <Group>
        <SwitchRow
          label="Swap lookalike letters"
          hint="а е о р с х and А В Е К М Н О Р С Т Х go out as their Latin twins: they look the same and take one byte instead of two, so about a fifth more text fits."
          checked={lookalikes.on}
          onChange={(v) => setLookalikePrefs({ on: v })}
        />
        {lookalikes.on ? <SwitchRow label="Also у and У" hint="The same as y and Y in most fonts, not in every one." checked={lookalikes.near} onChange={(v) => setLookalikePrefs({ near: v })} /> : null}
      </Group>
      <Group note={state.self ? "Chats and rooms. A route learned this long ago is dropped, and the next message floods to find a fresh one. A contact can set its own on its Route page." : "Kept per radio: connect to change it."}>
        <SelectRow
          label="Forget learned routes after"
          value={limitValue(state.routing.resetAfterMin)}
          disabled={!state.self}
          options={ROUTE_LIMITS.map((m) => ({ value: limitValue(m), label: limitLabel(m) }))}
          onChange={(v) => session.setDefaultRouteReset(parseLimit(v) ?? null)}
        />
      </Group>
    </>
  );
}

function AppearancePage() {
  const preference = useSyncExternalStore(subscribeTheme, getPreference);
  const textSize = useSyncExternalStore(subscribeTextSize, getTextSizePreference);
  const scale = useSyncExternalStore(subscribeTextSize, getTextScale);
  const system = useSyncExternalStore(subscribeTextSize, getSystemTextScale);
  // The step nearest the size drawn now; the system's own size may fall between two.
  const step = TEXT_STEPS.reduce((best, s, i) => (Math.abs(s - scale) < Math.abs((TEXT_STEPS[best] ?? 1) - scale) ? i : best), 0);
  const percent = (s: number) => `${Math.round(s * 100)}%`;
  return (
    <>
      <Group>
        <SelectRow label="Theme" value={preference} options={[{ value: "system", label: "Follow the system" }, ...listThemes().map((t) => ({ value: t.id, label: t.name }))]} onChange={(v) => setPreference(v)} />
      </Group>
      <Group title="Text size">
        {hasSystemTextSize() ? (
          <SwitchRow label="Follow the system" hint={`The phone's text size, ${percent(system)}`} checked={textSize === "system"} onChange={(v) => setTextSizePreference(v ? "system" : String(TEXT_STEPS[step] ?? 1))} />
        ) : null}
        <Block className="text-size">
          <span className="text-size-a" aria-hidden="true">
            A
          </span>
          <input
            type="range"
            min={0}
            max={TEXT_STEPS.length - 1}
            step={1}
            value={step}
            aria-label="Text size"
            aria-valuetext={percent(scale)}
            onChange={(e) => setTextSizePreference(String(TEXT_STEPS[Number(e.target.value)] ?? 1))}
          />
          <span className="text-size-a large" aria-hidden="true">
            A
          </span>
          <span className="text-size-value">{percent(scale)}</span>
        </Block>
        {/* What a chat looks like at this size, drawn by the chat's own rules. */}
        <Block className="text-sample">
          <div className="msg in">
            <div className="msg-col">
              <div className="bubble">
                <span className="msg-sender">Ridge</span>
                <span className="msg-text">Anyone hearing me from the valley?</span>
                <span className="msg-meta">
                  <span>18:04</span>
                </span>
              </div>
            </div>
          </div>
          <div className="msg out">
            <div className="msg-col">
              <div className="bubble">
                <span className="msg-text">Loud and clear, two hops.</span>
                <span className="msg-meta">
                  <span>18:05</span>
                </span>
              </div>
            </div>
          </div>
        </Block>
      </Group>
    </>
  );
}

function ConnectionPage() {
  const state = useSession();
  const [auto, setAuto] = useState(autoConnectWanted);
  return (
    <>
      <Group>
        <InfoRow label="Connected">{state.status === "ready" ? (state.link?.label ?? "yes") : "reconnecting…"}</InfoRow>
        <SwitchRow
          label="Reconnect at launch"
          checked={auto}
          onChange={(v) => {
            setAuto(v);
            setAutoConnect(v);
          }}
        />
      </Group>
      <Group note="Both lead to the connect screen, where another radio can be picked.">
        <ActionRow label="Disconnect" onClick={() => void disconnect()} />
      </Group>
    </>
  );
}

function PowerPage() {
  const state = useSession();
  const online = state.status === "ready";
  const [ask, setAsk] = useState<"reboot" | "reset" | "forget" | null>(null);
  return (
    <>
      <Group>
        <ActionRow label="Reboot the radio" disabled={!online} onClick={() => setAsk("reboot")} />
      </Group>
      <Group note="A factory reset erases every contact, channel and setting on the radio, and its identity with them. Deleting history leaves the radio untouched.">
        <ActionRow label="Factory reset the radio" danger disabled={!online} onClick={() => setAsk("reset")} />
        <ActionRow label="Delete the history on this device" danger disabled={!state.self} onClick={() => setAsk("forget")} />
      </Group>
      <Confirm
        open={ask === "reboot"}
        title="Reboot the radio?"
        body={<p>The link drops and comes back when the radio is up.</p>}
        confirmLabel="Reboot"
        onCancel={() => setAsk(null)}
        onConfirm={async () => {
          await act(() => session.reboot());
          setAsk(null);
        }}
      />
      <Confirm
        open={ask === "reset"}
        title="Factory reset the radio?"
        body={<p>Every contact, channel and setting on the radio is erased, and its identity with them: it becomes a new node with a new key. This cannot be undone.</p>}
        confirmLabel="Erase everything"
        danger
        onCancel={() => setAsk(null)}
        onConfirm={async () => {
          await act(() => session.factoryReset());
          setAsk(null);
        }}
      />
      <Confirm
        open={ask === "forget"}
        title="Delete the history?"
        body={<p>Every message this device has kept for this radio is deleted. The radio itself is untouched.</p>}
        confirmLabel="Delete"
        danger
        onCancel={() => setAsk(null)}
        onConfirm={async () => {
          const self = session.getState().self;
          if (self) await storage.forget(self.key);
          for (const conv of new Set(session.getState().messages.map((m) => m.conversation))) session.deleteConversation(conv);
          setAsk(null);
          toast("History deleted");
        }}
      />
    </>
  );
}
