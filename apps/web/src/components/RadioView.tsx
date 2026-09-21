import { useEffect, useState, type FormEvent } from "react";
import { fromHex, TelemMode, AdvertLocPolicy, type ChannelRecord } from "@meshnet/meshcore";
import { disconnect } from "../lib/link.js";
import { bandwidth, battery, batteryPercent, frequency } from "../lib/format.js";
import { useWide } from "../lib/layout.js";
import { goSection } from "../lib/nav.js";
import { session, storage, useSession } from "../lib/session.js";
import { Button, IconButton } from "../ui/Button.js";
import { Confirm, Dialog } from "../ui/Dialog.js";
import { Field, Input, Row, Section, Select } from "../ui/Field.js";
import { CopyIcon, PlusIcon, TrashIcon } from "./Icons.js";
import { Readings } from "./ContactCard.js";

interface Preset {
  name: string;
  frequencyKhz: number;
  bandwidthHz: number;
  spreadingFactor: number;
  codingRate: number;
}

const PRESETS: Preset[] = [
  { name: "EU/UK 869.525 · 250k · SF11 · CR5", frequencyKhz: 869_525, bandwidthHz: 250_000, spreadingFactor: 11, codingRate: 5 },
  { name: "EU narrow 869.618 · 62.5k · SF8 · CR8", frequencyKhz: 869_618, bandwidthHz: 62_500, spreadingFactor: 8, codingRate: 8 },
  { name: "US 910.525 · 62.5k · SF7 · CR5", frequencyKhz: 910_525, bandwidthHz: 62_500, spreadingFactor: 7, codingRate: 5 },
  { name: "ANZ 915.8 · 250k · SF10 · CR5", frequencyKhz: 915_800, bandwidthHz: 250_000, spreadingFactor: 10, codingRate: 5 },
  { name: "PKIO 869.161 · 62.5k · SF7 · CR7", frequencyKhz: 869_161, bandwidthHz: 62_500, spreadingFactor: 7, codingRate: 7 },
];

export function RadioView() {
  const state = useSession();
  const self = state.self;
  const device = state.device;
  const online = state.status === "ready";
  const wide = useWide();
  const [ask, setAsk] = useState<"reboot" | "reset" | "forget" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (online && !state.tuning) void session.refreshTuning().catch(() => undefined);
  }, [online, state.tuning]);

  const run = (name: string, action: () => Promise<unknown>) => async () => {
    setBusy(name);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!self) return <div className="empty muted">Not connected.</div>;

  return (
    <div className="card-scroll">
      {error ? <p className="connect-error">{error}</p> : null}

      <Section title="This radio">
        <NameForm name={self.name} disabled={!online} />
        <Row label="Public key">
          <code className="mono small">{self.key.slice(0, 16)}…</code>
          <IconButton label="Copy key" onClick={() => void navigator.clipboard?.writeText(self.key)}>
            <CopyIcon size={14} />
          </IconButton>
        </Row>
        {device ? (
          <>
            <Row label="Firmware">
              {device.firmwareVersion} · {device.buildDate} · protocol {device.firmwareVerCode}
            </Row>
            <Row label="Board">{device.manufacturer}</Row>
            <Row label="Capacity">
              {device.maxContacts} contacts · {device.maxChannels} channels
            </Row>
            {device.blePin ? <Row label="Bluetooth PIN">{String(device.blePin).padStart(6, "0")}</Row> : null}
          </>
        ) : null}
        <Row label="Battery">
          {state.battery ? `${battery(state.battery.mv)} · ~${batteryPercent(state.battery.mv)}%` : "—"}
          <Button size="sm" busy={busy === "batt"} disabled={!online} onClick={run("batt", () => session.refreshBattery())}>
            Refresh
          </Button>
        </Row>
        <div className="row-actions wrap">
          <Button busy={busy === "advert"} disabled={!online} onClick={run("advert", () => session.sendAdvert(false))}>
            Advertise nearby
          </Button>
          <Button busy={busy === "flood"} disabled={!online} onClick={run("flood", () => session.sendAdvert(true))}>
            Advertise across the mesh
          </Button>
          <Button busy={busy === "clock"} disabled={!online} onClick={run("clock", () => session.syncClock())}>
            Set clock
          </Button>
          <Button busy={busy === "telem"} disabled={!online} onClick={run("telem", () => session.requestTelemetry())}>
            Read sensors
          </Button>
        </div>
        {state.telemetry["self"] ? <Readings readings={state.telemetry["self"].readings} /> : null}
      </Section>

      <Section title="Location">
        <LocationForm lat={self.lat} lon={self.lon} policy={self.advertLocPolicy} disabled={!online} />
      </Section>

      <Section title="Radio">
        <RadioForm
          frequencyKhz={self.frequencyKhz}
          bandwidthHz={self.bandwidthHz}
          spreadingFactor={self.spreadingFactor}
          codingRate={self.codingRate}
          txPower={self.txPower}
          maxTxPower={self.maxTxPower}
          disabled={!online}
        />
      </Section>

      <Section title="Channels">
        <Channels channels={state.channels} max={device?.maxChannels ?? 8} disabled={!online} />
      </Section>

      <Section title="Behaviour">
        <OtherForm
          manualAddContacts={self.manualAddContacts}
          telemetryModeBase={self.telemetryModeBase}
          telemetryModeLocation={self.telemetryModeLocation}
          telemetryModeEnvironment={self.telemetryModeEnvironment}
          advertLocPolicy={self.advertLocPolicy}
          multiAcks={self.multiAcks}
          disabled={!online}
        />
      </Section>

      <Section title="Tuning">
        <TuningForm rxDelayBase={state.tuning?.rxDelayBase ?? 0} airtimeFactor={state.tuning?.airtimeFactor ?? 0} disabled={!online || !state.tuning} />
      </Section>

      {wide ? null : (
        <Section title="Log">
          <Row label="Events and frames" onClick={() => goSection("log")}>
            ›
          </Row>
        </Section>
      )}

      <Section title="Power">
        <div className="row-actions wrap">
          <Button onClick={() => void disconnect()}>Disconnect</Button>
          <Button disabled={!online} onClick={() => setAsk("reboot")}>
            Reboot radio
          </Button>
          <Button variant="danger" disabled={!online} onClick={() => setAsk("reset")}>
            Factory reset
          </Button>
          <Button variant="danger" onClick={() => setAsk("forget")}>
            Delete history on this device
          </Button>
        </div>
      </Section>

      <Confirm
        open={ask === "reboot"}
        title="Reboot the radio?"
        body={<p>The link drops and comes back when the radio is up.</p>}
        confirmLabel="Reboot"
        onCancel={() => setAsk(null)}
        onConfirm={async () => {
          await session.reboot();
          setAsk(null);
        }}
      />
      <Confirm
        open={ask === "reset"}
        title="Factory reset the radio?"
        body={
          <p>
            Every contact, channel and setting on the radio is erased, and its identity with them: it becomes a new node with a new key. This cannot be undone.
          </p>
        }
        confirmLabel="Erase everything"
        danger
        onCancel={() => setAsk(null)}
        onConfirm={async () => {
          await session.factoryReset();
          setAsk(null);
        }}
      />
      <Confirm
        open={ask === "forget"}
        title="Delete history?"
        body={<p>Every message this device has kept for this radio is deleted. The radio itself is untouched.</p>}
        confirmLabel="Delete"
        danger
        onCancel={() => setAsk(null)}
        onConfirm={async () => {
          await storage.forget(self.key);
          for (const conv of new Set(session.getState().messages.map((m) => m.conversation))) session.deleteConversation(conv);
          setAsk(null);
        }}
      />
    </div>
  );
}

function useForm<T extends object>(initial: T) {
  const [values, setValues] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!dirty) setValues(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(initial)]);
  const update = (patch: Partial<T>) => {
    setValues((v) => ({ ...v, ...patch }));
    setDirty(true);
  };
  const submit = (action: (values: T) => Promise<void>) => async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await action(values);
      setDirty(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { values, update, dirty, busy, error, submit, reset: () => { setValues(initial); setDirty(false); } };
}

function FormFoot({ dirty, busy, error, onReset }: { dirty: boolean; busy: boolean; error: string | null; onReset: () => void }) {
  return (
    <div className="form-foot">
      {error ? <span className="connect-error">{error}</span> : <span />}
      <span className="row-actions">
        {dirty ? <Button onClick={onReset}>Revert</Button> : null}
        <Button variant="primary" type="submit" disabled={!dirty} busy={busy}>
          Save
        </Button>
      </span>
    </div>
  );
}

function NameForm({ name, disabled }: { name: string; disabled: boolean }) {
  const form = useForm({ name });
  return (
    <form className="stack" onSubmit={form.submit((v) => session.setName(v.name.trim()))}>
      <Field label="Name" hint="What other radios see in adverts and before your channel messages.">
        <Input value={form.values.name} maxLength={31} disabled={disabled} onChange={(e) => form.update({ name: e.target.value })} />
      </Field>
      <FormFoot dirty={form.dirty} busy={form.busy} error={form.error} onReset={form.reset} />
    </form>
  );
}

function LocationForm({ lat, lon, policy, disabled }: { lat: number; lon: number; policy: number; disabled: boolean }) {
  const form = useForm({ lat: String(lat), lon: String(lon) });
  const locate = () => {
    navigator.geolocation?.getCurrentPosition(
      (pos) => form.update({ lat: pos.coords.latitude.toFixed(6), lon: pos.coords.longitude.toFixed(6) }),
      () => undefined,
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };
  return (
    <form className="stack" onSubmit={form.submit((v) => session.setLocation(Number(v.lat), Number(v.lon)))}>
      <div className="two">
        <Field label="Latitude">
          <Input inputMode="decimal" value={form.values.lat} disabled={disabled} onChange={(e) => form.update({ lat: e.target.value })} />
        </Field>
        <Field label="Longitude">
          <Input inputMode="decimal" value={form.values.lon} disabled={disabled} onChange={(e) => form.update({ lon: e.target.value })} />
        </Field>
      </div>
      <p className="muted small">
        {policy === AdvertLocPolicy.None ? "Not shared in adverts (see Behaviour)." : "Shared in adverts."}
        {"geolocation" in navigator ? (
          <>
            {" "}
            <button type="button" className="link" onClick={locate} disabled={disabled}>
              Use this device's position
            </button>
          </>
        ) : null}
      </p>
      <FormFoot dirty={form.dirty} busy={form.busy} error={form.error} onReset={form.reset} />
    </form>
  );
}

function RadioForm(props: { frequencyKhz: number; bandwidthHz: number; spreadingFactor: number; codingRate: number; txPower: number; maxTxPower: number; disabled: boolean }) {
  const form = useForm({
    frequency: (props.frequencyKhz / 1000).toFixed(3),
    bandwidth: (props.bandwidthHz / 1000).toString(),
    sf: String(props.spreadingFactor),
    cr: String(props.codingRate),
    tx: String(props.txPower),
  });
  const applyPreset = (p: Preset) =>
    form.update({ frequency: (p.frequencyKhz / 1000).toFixed(3), bandwidth: (p.bandwidthHz / 1000).toString(), sf: String(p.spreadingFactor), cr: String(p.codingRate) });
  return (
    <form
      className="stack"
      onSubmit={form.submit(async (v) => {
        await session.setRadioParams({
          frequencyKhz: Math.round(Number(v.frequency) * 1000),
          bandwidthHz: Math.round(Number(v.bandwidth) * 1000),
          spreadingFactor: Number(v.sf),
          codingRate: Number(v.cr),
        });
        if (Number(v.tx) !== props.txPower) await session.setTxPower(Number(v.tx));
      })}
    >
      <Field label="Preset">
        <Select value="" disabled={props.disabled} onChange={(e) => { const p = PRESETS[Number(e.target.value)]; if (p) applyPreset(p); }}>
          <option value="">Choose…</option>
          {PRESETS.map((p, i) => (
            <option key={p.name} value={i}>
              {p.name}
            </option>
          ))}
        </Select>
      </Field>
      <div className="two">
        <Field label="Frequency, MHz">
          <Input inputMode="decimal" value={form.values.frequency} disabled={props.disabled} onChange={(e) => form.update({ frequency: e.target.value })} />
        </Field>
        <Field label="Bandwidth, kHz">
          <Select value={form.values.bandwidth} disabled={props.disabled} onChange={(e) => form.update({ bandwidth: e.target.value })}>
            {["7.8", "10.4", "15.6", "20.8", "31.25", "41.7", "62.5", "125", "250", "500"].map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="two">
        <Field label="Spreading factor">
          <Select value={form.values.sf} disabled={props.disabled} onChange={(e) => form.update({ sf: e.target.value })}>
            {[5, 6, 7, 8, 9, 10, 11, 12].map((n) => (
              <option key={n} value={n}>
                SF{n}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Coding rate">
          <Select value={form.values.cr} disabled={props.disabled} onChange={(e) => form.update({ cr: e.target.value })}>
            {[5, 6, 7, 8].map((n) => (
              <option key={n} value={n}>
                4/{n}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label={`Transmit power, dBm (up to ${props.maxTxPower})`}>
        <Input type="number" min={-9} max={props.maxTxPower} value={form.values.tx} disabled={props.disabled} onChange={(e) => form.update({ tx: e.target.value })} />
      </Field>
      <p className="muted small">
        Now: {frequency(props.frequencyKhz)}, {bandwidth(props.bandwidthHz)}, SF{props.spreadingFactor}, CR 4/{props.codingRate}, {props.txPower} dBm. Every radio on a mesh must match.
      </p>
      <FormFoot dirty={form.dirty} busy={form.busy} error={form.error} onReset={form.reset} />
    </form>
  );
}

function OtherForm(props: { manualAddContacts: number; telemetryModeBase: number; telemetryModeLocation: number; telemetryModeEnvironment: number; advertLocPolicy: number; multiAcks: number; disabled: boolean }) {
  const form = useForm({
    manual: String(props.manualAddContacts & 1),
    base: String(props.telemetryModeBase),
    loc: String(props.telemetryModeLocation),
    env: String(props.telemetryModeEnvironment),
    policy: String(props.advertLocPolicy),
    acks: String(props.multiAcks),
  });
  const modes = (
    <>
      <option value={TelemMode.Deny}>Nobody</option>
      <option value={TelemMode.AllowFlags}>Contacts marked for it</option>
      <option value={TelemMode.AllowAll}>Anyone</option>
    </>
  );
  return (
    <form
      className="stack"
      onSubmit={form.submit((v) =>
        session.setOtherParams({
          manualAddContacts: Number(v.manual),
          telemetryModeBase: Number(v.base),
          telemetryModeLocation: Number(v.loc),
          telemetryModeEnvironment: Number(v.env),
          advertLocPolicy: Number(v.policy),
          multiAcks: Number(v.acks),
        }),
      )}
    >
      <Field label="New contacts" hint="Whether radios heard advertising are added by themselves.">
        <Select value={form.values.manual} disabled={props.disabled} onChange={(e) => form.update({ manual: e.target.value })}>
          <option value="0">Add automatically</option>
          <option value="1">Only when I add them</option>
        </Select>
      </Field>
      <Field label="Location in adverts">
        <Select value={form.values.policy} disabled={props.disabled} onChange={(e) => form.update({ policy: e.target.value })}>
          <option value={AdvertLocPolicy.None}>Not shared</option>
          <option value={AdvertLocPolicy.Share}>Shared</option>
        </Select>
      </Field>
      <div className="two">
        <Field label="Battery telemetry to">
          <Select value={form.values.base} disabled={props.disabled} onChange={(e) => form.update({ base: e.target.value })}>{modes}</Select>
        </Field>
        <Field label="Location telemetry to">
          <Select value={form.values.loc} disabled={props.disabled} onChange={(e) => form.update({ loc: e.target.value })}>{modes}</Select>
        </Field>
      </div>
      <div className="two">
        <Field label="Sensor telemetry to">
          <Select value={form.values.env} disabled={props.disabled} onChange={(e) => form.update({ env: e.target.value })}>{modes}</Select>
        </Field>
        <Field label="Extra acknowledgements" hint="Repeats of each ack, for lossy links.">
          <Select value={form.values.acks} disabled={props.disabled} onChange={(e) => form.update({ acks: e.target.value })}>
            {[0, 1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <FormFoot dirty={form.dirty} busy={form.busy} error={form.error} onReset={form.reset} />
    </form>
  );
}

function TuningForm({ rxDelayBase, airtimeFactor, disabled }: { rxDelayBase: number; airtimeFactor: number; disabled: boolean }) {
  const form = useForm({ rx: String(rxDelayBase), af: String(airtimeFactor) });
  return (
    <form className="stack" onSubmit={form.submit((v) => session.setTuning(Number(v.rx), Number(v.af)))}>
      <div className="two">
        <Field label="Receive delay base" hint="0 disables the receive back-off.">
          <Input inputMode="decimal" value={form.values.rx} disabled={disabled} onChange={(e) => form.update({ rx: e.target.value })} />
        </Field>
        <Field label="Airtime factor" hint="How much the radio holds back after transmitting.">
          <Input inputMode="decimal" value={form.values.af} disabled={disabled} onChange={(e) => form.update({ af: e.target.value })} />
        </Field>
      </div>
      <FormFoot dirty={form.dirty} busy={form.busy} error={form.error} onReset={form.reset} />
    </form>
  );
}

function Channels({ channels, max, disabled }: { channels: ChannelRecord[]; max: number; disabled: boolean }) {
  const [editing, setEditing] = useState<ChannelRecord | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ChannelRecord | null>(null);
  const used = new Set(channels.map((c) => c.index));
  let free = -1;
  for (let i = 0; i < max; i++) {
    if (!used.has(i)) {
      free = i;
      break;
    }
  }
  return (
    <div className="stack">
      {channels.length === 0 ? <p className="muted small">No channels on the radio.</p> : null}
      {channels.map((c) => (
        <Row key={c.index} label={`${c.index} · ${c.name || "(unnamed)"}`} onClick={disabled ? undefined : () => setEditing(c)}>
          <code className="mono small">{c.secret.slice(0, 8)}…</code>
        </Row>
      ))}
      <div className="row-actions">
        <Button disabled={disabled || free < 0} onClick={() => setAdding(true)}>
          <PlusIcon size={14} /> Add channel
        </Button>
      </div>
      <ChannelDialog
        open={adding || editing !== null}
        channel={editing}
        index={editing?.index ?? free}
        onClose={() => {
          setAdding(false);
          setEditing(null);
        }}
        onRemove={
          editing && editing.index !== 0
            ? () => {
                setRemoving(editing);
                setEditing(null);
              }
            : undefined
        }
      />
      <Confirm
        open={removing !== null}
        title={`Remove channel ${removing?.name ?? ""}?`}
        body={<p>The radio stops listening on it. Its messages stay here.</p>}
        confirmLabel="Remove"
        danger
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          if (removing) await session.clearChannel(removing.index);
          setRemoving(null);
        }}
      />
    </div>
  );
}

function randomSecret(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function ChannelDialog({ open, channel, index, onClose, onRemove }: { open: boolean; channel: ChannelRecord | null; index: number; onClose: () => void; onRemove?: (() => void) | undefined }) {
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setName(channel?.name ?? "");
    setSecret(channel?.secret ?? randomSecret());
    setError(null);
  }, [open, channel]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const bytes = fromHex(secret);
      if (bytes.length !== 16) throw new Error("the key is 16 bytes: 32 hex characters");
      await session.setChannel(index, name.trim(), bytes);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} title={channel ? `Channel ${channel.index}` : `New channel ${index}`} onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <Field label="Name">
          <Input value={name} maxLength={31} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Key, hex" hint="Shared with everyone on the channel. A new one is random; paste one to join a channel that exists.">
          <Input className="mono" value={secret} onChange={(e) => setSecret(e.target.value.replace(/\s+/g, ""))} />
        </Field>
        {error ? <p className="connect-error">{error}</p> : null}
        <div className="dialog-foot">
          {onRemove ? (
            <Button variant="danger" onClick={onRemove}>
              <TrashIcon size={14} /> Remove
            </Button>
          ) : null}
          <span className="grow" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" busy={busy}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
