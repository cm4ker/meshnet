import { useEffect, useMemo, useState } from "react";
import { AdvType, type ContactRecord } from "@meshnet/meshcore";
import { closeCleanUp, removeNodes, useCleanUpOpen } from "../lib/cleanUp.js";
import { ago } from "../lib/format.js";
import { useSavedPasswords } from "../lib/secrets.js";
import { useSession } from "../lib/session.js";
import { KEEP_LABELS, TIDY_DAYS, tidyPlan, useTidyDays, type KeepReason } from "../lib/tidy.js";
import { heardAt, kindLabel } from "../lib/nodes.js";
import { Button } from "../ui/Button.js";
import { Group, LinkRow, SelectRow } from "../ui/List.js";
import { Sheet } from "../ui/Sheet.js";
import { Avatar } from "./Avatar.js";

const KIND_NAMES: [number, string, string][] = [
  [AdvType.Chat, "person", "people"],
  [AdvType.Repeater, "repeater", "repeaters"],
  [AdvType.Room, "room", "rooms"],
  [AdvType.Sensor, "sensor", "sensors"],
];

function byKind(list: ContactRecord[]): string {
  return KIND_NAMES.map(([type, one, many]) => {
    const n = list.filter((c) => c.type === type).length;
    return n ? `${n} ${n === 1 ? one : many}` : null;
  })
    .filter(Boolean)
    .join(" · ");
}

const KEEP_WHY: Record<KeepReason, string> = {
  favourite: "favourites",
  yours: "yours",
  chat: "chats",
};

/** One sheet for the whole mesh: the nodes not heard for a while, one number, one button; the list behind a tap. */
export function CleanUpHost() {
  const open = useCleanUpOpen();
  return open ? <CleanUpSheet /> : null;
}

function CleanUpSheet() {
  const state = useSession();
  const saved = useSavedPasswords();
  const rule = useTidyDays(state.self?.key ?? null);
  const [days, setDays] = useState<number>(rule || 30);
  const [review, setReview] = useState(false);
  // The plan is taken when the sheet opens and when the days change, so rows do not jump under a finger.
  const plan = useMemo(() => tidyPlan(state, saved, days, Date.now()), [days, state.self?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const [picked, setPicked] = useState<Set<string>>(() => new Set(plan.remove.map((c) => c.key)));
  useEffect(() => setPicked(new Set(plan.remove.map((c) => c.key))), [plan]);
  const online = state.status === "ready";
  const n = picked.size;
  const toggle = (key: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const pickedChats = plan.kept.filter((k) => k.reason === "chat" && picked.has(k.contact.key));

  const go = () => {
    const keys = [...plan.remove, ...plan.kept.map((k) => k.contact)].map((c) => c.key).filter((k) => picked.has(k));
    closeCleanUp();
    void removeNodes(keys);
  };

  const title = n ? `Remove ${n} ${n === 1 ? "node" : "nodes"}` : "Clean up";
  const keptWhy = [...new Set(plan.kept.map((k) => KEEP_WHY[k.reason]))];
  return (
    <Sheet open onClose={closeCleanUp} title={title}>
      <p className="group-note cleanup-note">
        {plan.remove.length || plan.kept.length
          ? `Not heard for over ${days} days. You can put any of them back from Radio › Contacts › Removed.`
          : `Every node was heard in the last ${days} days.`}
      </p>
      {plan.remove.length ? <p className="group-note cleanup-kinds">{byKind(plan.remove)}</p> : null}
      <Group>
        <SelectRow label="Not heard for" value={String(days)} options={TIDY_DAYS.map((d) => ({ value: String(d), label: `${d} days` }))} onChange={(v) => setDays(Number(v))} />
        {plan.remove.length || plan.kept.length ? <LinkRow label={review ? "Hide the list" : "Review the list"} value={plan.remove.length + plan.kept.length} onClick={() => setReview(!review)} /> : null}
      </Group>
      {review ? (
        <>
          {plan.remove.length ? <PickList title={`Not heard ${days}+ days`} rows={plan.remove.map((c) => ({ contact: c, reason: null }))} picked={picked} onToggle={toggle} /> : null}
          {plan.kept.length ? <PickList title="Kept" rows={plan.kept} picked={picked} onToggle={toggle} /> : null}
        </>
      ) : null}
      {plan.kept.length ? (
        <p className="group-note">
          <b className="cleanup-kept">{plan.kept.length} kept</b> {keptWhy.join(", ")}
        </p>
      ) : null}
      {pickedChats.length ? (
        <p className="group-note danger">
          {pickedChats.length === 1 ? `${pickedChats[0]!.contact.name || pickedChats[0]!.contact.prefix}'s direct messages` : "Direct messages from the chats picked"} won't reach you until they advertise again.
        </p>
      ) : null}
      <div className="sheet-form cleanup-actions">
        <Button variant="danger" size="lg" disabled={!n || !online || !!state.removing} onClick={go}>
          {n ? `Remove ${n}` : "Nothing to remove"}
        </Button>
      </div>
    </Sheet>
  );
}

function PickList({ title, rows, picked, onToggle }: { title: string; rows: { contact: ContactRecord; reason: KeepReason | null }[]; picked: ReadonlySet<string>; onToggle: (key: string) => void }) {
  return (
    <>
      <div className="list-group">{title}</div>
      <ul className="list-rows cleanup-list" role="list">
        {rows.map(({ contact: c, reason }) => (
          <li key={c.key}>
            <label className="row cleanup-row">
              <input type="checkbox" checked={picked.has(c.key)} onChange={() => onToggle(c.key)} />
              <Avatar name={c.name || c.prefix} type={c.type} size={32} />
              <span className="row-main">
                <span className="row-top">
                  <span className="row-title">{c.name || c.prefix}</span>
                  <span className="row-when muted">{ago(heardAt(c) || null)}</span>
                </span>
                <span className="row-sub muted">{reason ? `${kindLabel(c.type)} · ${KEEP_LABELS[reason]}` : kindLabel(c.type)}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </>
  );
}
