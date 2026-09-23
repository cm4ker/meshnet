/**
 * Radio › Contacts: which new nodes the radio keeps, what it does once its
 * memory is full, the tidy-up rule, and the contacts taken off it, to be put
 * back. The first three are the radio's own settings (`manual_add_contacts`,
 * `autoadd_config`, `autoadd_max_hops` in the firmware); the rule is this app's.
 */

import { useMemo, useState } from "react";
import { AutoAdd, ContactFlag, type RemovedContact, type SessionState } from "@meshnet/meshcore";
import { openCleanUp } from "../lib/cleanUp.js";
import { ago, agoPhrase } from "../lib/format.js";
import { push } from "../lib/nav.js";
import { kindLabel } from "../lib/nodes.js";
import { useSavedPasswords } from "../lib/secrets.js";
import { session, useSession } from "../lib/session.js";
import { chatKeys, isYours, memoryUse, setTidyDays, TIDY_DAYS, useTidyDays } from "../lib/tidy.js";
import { act, toast } from "../lib/toast.js";
import { Button } from "../ui/Button.js";
import { Confirm } from "../ui/Dialog.js";
import { ActionRow, Group, InfoRow, LinkRow, SelectRow, SwitchRow } from "../ui/List.js";
import { Avatar } from "./Avatar.js";

type Self = NonNullable<SessionState["self"]>;
type Mode = "all" | "kinds" | "manual";

const KIND_BITS = AutoAdd.Chat | AutoAdd.Repeater | AutoAdd.Room | AutoAdd.Sensor;

const KINDS: { bit: number; label: string }[] = [
  { bit: AutoAdd.Chat, label: "People" },
  { bit: AutoAdd.Repeater, label: "Repeaters" },
  { bit: AutoAdd.Room, label: "Rooms" },
  { bit: AutoAdd.Sensor, label: "Sensors" },
];

/** `autoadd_max_hops`: 0 is any distance, 1 heard directly, N up to N-1 hops. */
const HOPS = [
  { value: "0", label: "Any distance" },
  { value: "1", label: "Heard directly" },
  { value: "2", label: "Up to 1 hop" },
  { value: "3", label: "Up to 2 hops" },
  { value: "4", label: "Up to 3 hops" },
  { value: "6", label: "Up to 5 hops" },
];

function modeOf(self: Self, config: number): Mode {
  if ((self.manualAddContacts & 1) === 0) return "all";
  return config & KIND_BITS ? "kinds" : "manual";
}

/** Only this one flag changes; the rest of the radio's settings go back as they are. */
function setManualAdd(self: Self, manual: boolean) {
  return session.setOtherParams({
    manualAddContacts: (self.manualAddContacts & ~1) | (manual ? 1 : 0),
    telemetryModeBase: self.telemetryModeBase,
    telemetryModeLocation: self.telemetryModeLocation,
    telemetryModeEnvironment: self.telemetryModeEnvironment,
    advertLocPolicy: self.advertLocPolicy,
    multiAcks: self.multiAcks,
  });
}

export function ContactsPage() {
  const state = useSession();
  const saved = useSavedPasswords();
  const self = state.self;
  const rule = useTidyDays(self?.key ?? null);
  const [askStars, setAskStars] = useState(false);
  const online = state.status === "ready";
  const autoAdd = state.autoAdd;
  const config = autoAdd?.config ?? 0;
  const use = memoryUse(state);
  const removed = Object.keys(state.removed).length;
  // Only a star keeps a contact from being replaced: the ones this app keeps for other reasons, unstarred.
  const unstarred = useMemo(() => {
    const chats = chatKeys(state);
    return Object.values(state.contacts).filter((c) => !c.unsaved && !(c.flags & ContactFlag.Favourite) && (chats.has(c.key) || isYours(state, saved, c)));
  }, [state, saved]);

  if (!self) return <div className="empty muted">Connect to the radio to see this.</div>;
  const mode = modeOf(self, config);

  const setMode = (next: Mode) =>
    void act(async () => {
      await setManualAdd(self, next !== "all");
      if (autoAdd && next === "kinds" && !(config & KIND_BITS)) await session.setAutoAdd(config | AutoAdd.Chat | AutoAdd.Room, autoAdd.maxHops);
      if (autoAdd && next === "manual" && config & KIND_BITS) await session.setAutoAdd(config & ~KIND_BITS, autoAdd.maxHops);
    }, "Saved to the radio");
  const setConfig = (next: number) => autoAdd && void act(() => session.setAutoAdd(next, autoAdd.maxHops), "Saved to the radio");
  const setReplace = async (on: boolean) => {
    if (!autoAdd) return;
    const ok = await act(() => session.setAutoAdd(on ? config | AutoAdd.OverwriteOldest : config & ~AutoAdd.OverwriteOldest, autoAdd.maxHops), "Saved to the radio");
    if (ok && on && unstarred.length) setAskStars(true);
  };

  return (
    <>
      <Group title="New nodes" note={autoAdd ? "Replacing never touches favourites." : "This radio's firmware keeps every new node or none; update it to choose kinds and distance."}>
        {autoAdd ? (
          <SelectRow<Mode>
            label="Keep"
            value={mode}
            disabled={!online}
            options={[
              { value: "all", label: "Every node" },
              { value: "kinds", label: "Only these kinds" },
              { value: "manual", label: "Only ones I add" },
            ]}
            onChange={setMode}
          />
        ) : (
          <SelectRow<Mode>
            label="Keep"
            value={mode === "all" ? "all" : "manual"}
            disabled={!online}
            options={[
              { value: "all", label: "Every node" },
              { value: "manual", label: "Only ones I add" },
            ]}
            onChange={setMode}
          />
        )}
        {autoAdd && mode === "kinds"
          ? KINDS.map((k) => <SwitchRow key={k.bit} label={k.label} checked={!!(config & k.bit)} disabled={!online} onChange={(v) => setConfig(v ? config | k.bit : config & ~k.bit)} />)
          : null}
        {autoAdd && mode !== "manual" ? (
          <SelectRow label="How far" value={String(autoAdd.maxHops)} disabled={!online} options={HOPS.some((h) => h.value === String(autoAdd.maxHops)) ? HOPS : [...HOPS, { value: String(autoAdd.maxHops), label: `Up to ${autoAdd.maxHops - 1} hops` }]} onChange={(v) => void act(() => session.setAutoAdd(config, Number(v)), "Saved to the radio")} />
        ) : null}
        {autoAdd ? (
          <SelectRow
            label="When memory is full"
            value={config & AutoAdd.OverwriteOldest ? "replace" : "drop"}
            disabled={!online}
            options={[
              { value: "drop", label: "Don't keep new ones" },
              { value: "replace", label: "Replace the oldest" },
            ]}
            onChange={(v) => void setReplace(v === "replace")}
          />
        ) : null}
      </Group>

      <Group title="Tidy up" note="Favourites, yours and chats stay. Runs while this app is connected to the radio.">
        <SelectRow
          label="Remove nodes not heard for"
          value={String(rule)}
          options={[{ value: "0", label: "Off" }, ...TIDY_DAYS.map((d) => ({ value: String(d), label: `${d} days` }))]}
          onChange={(v) => setTidyDays(self.key, Number(v))}
        />
        <LinkRow label="Removed" value={removed || undefined} onClick={() => push({ kind: "radio", page: "removed" })} />
      </Group>

      <Group title="Memory">
        {use ? <InfoRow label={`${use.used} of ${use.max} used`}>{state.contactsFull ? <span className="danger">full</span> : null}</InfoRow> : null}
        <ActionRow label="Clean up" disabled={!online || !!state.removing} onClick={openCleanUp} />
      </Group>

      <Confirm
        open={askStars}
        title={`Star ${unstarred.length} ${unstarred.length === 1 ? "node" : "nodes"}?`}
        body={<p>The radio replaces any contact without a star, even one you write to or sign in to. A star keeps {unstarred.length === 1 ? (unstarred[0]!.name || unstarred[0]!.prefix) : "these"} on it.</p>}
        confirmLabel="Star them"
        onCancel={() => setAskStars(false)}
        onConfirm={async () => {
          setAskStars(false);
          await act(async () => {
            for (const c of unstarred) await session.setFavourite(c.key, true);
          }, `Starred ${unstarred.length}`);
        }}
      />
    </>
  );
}

const BY: Record<RemovedContact["by"], string> = {
  you: "by you",
  tidy: "by clean-up",
  radio: "by the radio",
};

/** The contacts taken off the radio in the last 90 days, newest first, each with Put back. */
export function RemovedPage() {
  const state = useSession();
  const online = state.status === "ready";
  const [busy, setBusy] = useState<string | null>(null);
  const rows = Object.values(state.removed).sort((a, b) => b.at - a.at);
  if (rows.length === 0) return <div className="empty muted">Nothing removed. Contacts taken off the radio are kept here for 90 days, to be put back.</div>;
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const recent = rows.filter((r) => r.at >= weekAgo);
  const earlier = rows.filter((r) => r.at < weekAgo);
  const putBack = async (key: string, name: string) => {
    setBusy(key);
    await act(() => session.restoreContact(key), `${name} is back on the radio`);
    setBusy(null);
  };
  const list = (title: string, items: RemovedContact[]) =>
    items.length ? (
      <Group title={title}>
        {items.map((r) => {
          const c = r.contact;
          const name = c.name || c.prefix;
          return (
            <div key={c.key} className="line">
              <Avatar name={name} type={c.type} size={32} />
              <span className="line-text">
                <span>{name}</span>
                <small>
                  {kindLabel(c.type)} · {BY[r.by]} · {ago(r.at)}
                </small>
              </span>
              <Button size="sm" busy={busy === c.key} disabled={!online || busy !== null} onClick={() => void putBack(c.key, name)}>
                Put back
              </Button>
            </div>
          );
        })}
      </Group>
    ) : null;
  return (
    <>
      {list("This week", recent)}
      {list("Earlier", earlier)}
      <p className="group-note">Kept for 90 days. Chats with these nodes stay in Chats.</p>
    </>
  );
}

/** Says a contact is on the radio no more, or was never kept, and puts it back. For the profile and the chat. */
export function NotOnRadio({ contactKey, compact = false }: { contactKey: string; compact?: boolean }) {
  const state = useSession();
  const removed = state.removed[contactKey];
  const heard = state.contacts[contactKey];
  const [busy, setBusy] = useState(false);
  const record = removed?.contact ?? (heard?.unsaved ? heard : null);
  if (!record) return null;
  const name = record.name || record.prefix;
  const why = removed
    ? removed.by === "radio"
      ? `The radio let ${name} go, likely when its memory was full.`
      : `${name} was taken off the radio ${removed.at >= Date.now() - 7 * 86_400_000 ? agoPhrase(removed.at) : `on ${agoPhrase(removed.at)}`}.`
    : `The radio heard ${name} but didn't keep it.`;
  const add = async () => {
    setBusy(true);
    const ok = await act(() => session.restoreContact(contactKey));
    setBusy(false);
    if (ok) toast(`${name} is on the radio`);
  };
  return (
    <div className={["not-on-radio", compact ? "compact" : ""].join(" ")}>
      <p>
        <b>Not on your radio.</b> {why} Messages can't go to {name}, and theirs won't reach you.
      </p>
      <Button variant="primary" busy={busy} disabled={state.status !== "ready"} onClick={() => void add()}>
        {removed ? "Put back on the radio" : "Add to the radio"}
      </Button>
    </div>
  );
}
