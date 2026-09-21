import { useEffect, useMemo, useState } from "react";
import { MAX_PASSWORD_LEN, NoReplyError, NodeCommandError, isCliError, type ContactRecord } from "@meshnet/meshcore";
import { ago, plural } from "../../lib/format.js";
import {
  RADIO_FIELDS,
  displayValue,
  formatRadio,
  groupReads,
  parseRadio,
  readCommand,
  settingGroups,
  storedValue,
  validate,
  validateRadio,
  writeCommand,
  type RadioValue,
  type SettingField,
  type SettingGroup,
} from "../../lib/nodes.js";
import { hasSavedPassword, savePassword } from "../../lib/secrets.js";
import { session, useSession } from "../../lib/session.js";
import { Button } from "../../ui/Button.js";
import { Confirm } from "../../ui/Dialog.js";
import { Section } from "../../ui/Field.js";
import { AlertIcon } from "../Icons.js";

/** How long a trial of new radio settings lasts before the node falls back by itself. */
const TRIAL_MINUTES = 10;

interface Pending {
  name: string;
  value: string;
  command: string;
}

function message(e: unknown): string {
  if (e instanceof NoReplyError) return `${e.message}. The node may be out of range; try again.`;
  if (e instanceof NodeCommandError) return `The node said: ${e.reply}`;
  return (e as Error).message;
}

/**
 * The node's settings, as forms over its console: a group is read with
 * `get`, one request per value, only when asked; changes are collected and
 * sent as the `set` commands shown before they go.
 */
export function Settings({ contact }: { contact: ContactRecord }) {
  const state = useSession();
  const key = contact.key;
  const online = state.status === "ready";
  const stored = state.nodeSettings[key] ?? {};
  const groups = settingGroups(contact.type);
  const [dirty, setDirty] = useState<Record<string, string>>({});
  const [reading, setReading] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [showCommands, setShowCommands] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [ask, setAsk] = useState<"radio" | "password" | null>(null);
  const [password, setPassword] = useState("");

  useEffect(() => {
    setDirty({});
    setError(null);
    setNote(null);
    setPassword("");
  }, [key]);

  const radio = parseRadio(stored["radio"]?.value);
  const current = (name: string): string => {
    const radioField = RADIO_FIELDS.find((f) => f.name === name);
    if (radioField) return radio?.[name as keyof RadioValue] ?? "";
    const value = stored[name]?.value;
    return value === undefined ? "" : displayValue(name, value);
  };
  const shown = (name: string) => dirty[name] ?? current(name);

  const setField = (name: string, value: string) => {
    setDirty((d) => {
      const next = { ...d };
      if (value === current(name)) delete next[name];
      else next[name] = value;
      return next;
    });
  };

  const { pending, radioValue, problems } = useMemo(() => {
    const pending: Pending[] = [];
    const problems: Record<string, string> = {};
    for (const group of groups) {
      for (const field of group.fields) {
        const value = dirty[field.name];
        if (value === undefined) continue;
        const problem = validate(field, value);
        if (problem) problems[field.name] = problem;
        pending.push({ name: field.name, value: storedValue(field.name, value), command: writeCommand(field.name, value) });
      }
    }
    let radioValue: string | null = null;
    if (radio && RADIO_FIELDS.some((f) => dirty[f.name] !== undefined)) {
      const next: RadioValue = { freq: shown("freq"), bw: shown("bw"), sf: shown("sf"), cr: shown("cr") };
      const problem = validateRadio(next);
      if (problem) problems["freq"] = problem;
      radioValue = formatRadio(next);
    }
    return { pending, radioValue, problems };
    // `shown` reads `dirty` and `stored`, both listed.
  }, [dirty, stored, contact.type]);

  const read = async (group: SettingGroup) => {
    setReading((r) => new Set(r).add(group.id));
    setError(null);
    const refused: string[] = [];
    try {
      for (const name of groupReads(group)) {
        try {
          await session.readNodeSetting(key, name, readCommand(name));
        } catch (e) {
          if (e instanceof NodeCommandError) refused.push(`${name} (${e.reply})`);
          else throw e;
        }
      }
      if (refused.length) setNote(`This node does not know ${refused.join(", ")}; its firmware may be older.`);
    } catch (e) {
      setError(message(e));
    } finally {
      setReading((r) => {
        const next = new Set(r);
        next.delete(group.id);
        return next;
      });
    }
  };

  const apply = async (radioMode: "trial" | "save" | null) => {
    setApplying(true);
    setError(null);
    setNote(null);
    try {
      for (const p of pending) {
        await session.writeNodeSetting(key, p.name, p.value, p.command);
        setDirty((d) => {
          const next = { ...d };
          delete next[p.name];
          return next;
        });
      }
      if (radioValue && radioMode === "trial") {
        const reply = await session.runCli(key, `tempradio ${radioValue},${TRIAL_MINUTES}`);
        if (isCliError(reply)) throw new NodeCommandError(reply);
        setNote(`${contact.name} is on the new radio settings for ${TRIAL_MINUTES} minutes. Switch this radio to them to reach it; if nobody does, it goes back by itself.`);
      } else if (radioValue && radioMode === "save") {
        await session.writeNodeSetting(key, "radio", radioValue, `set radio ${radioValue}`);
        setNote(`${contact.name} keeps the new radio settings from its next reboot.`);
      } else {
        setNote(`${plural(pending.length, "change")} saved on ${contact.name}.`);
      }
      if (radioValue && radioMode) {
        setDirty((d) => {
          const next = { ...d };
          for (const f of RADIO_FIELDS) delete next[f.name];
          return next;
        });
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setApplying(false);
    }
  };

  const changePassword = async () => {
    setError(null);
    setNote(null);
    try {
      await session.writeNodeSetting(key, "password", password, `password ${password}`, { mask: "password ••••••" });
      if (hasSavedPassword(key)) await savePassword(key, password);
      setPassword("");
      setNote(hasSavedPassword(key) ? "Admin password changed, and the saved one with it." : "Admin password changed.");
    } catch (e) {
      setError(message(e));
    }
  };

  const total = pending.length + (radioValue ? 1 : 0);
  const invalid = Object.keys(problems).length > 0;
  const commands = [...pending.map((p) => p.command), ...(radioValue ? [`tempradio ${radioValue},${TRIAL_MINUTES}  or  set radio ${radioValue}`] : [])];
  const passwordTooLong = new TextEncoder().encode(password).length > MAX_PASSWORD_LEN;

  return (
    <>
      <div className="card-scroll">
        {error ? <p className="connect-error">{error}</p> : null}
        {note ? <p className="muted small">{note}</p> : null}

        {groups.map((group) => {
          const names = groupReads(group);
          const known = names.filter((n) => stored[n] !== undefined);
          const busy = reading.has(group.id);
          const at = known.length ? Math.max(...known.map((n) => stored[n]!.at)) : null;
          return (
            <Section
              key={group.id}
              title={group.title}
              actions={
                <>
                  <span className="muted small">{busy ? `reading ${known.length} of ${names.length}…` : at ? `read ${ago(at)}` : "not read"}</span>
                  {known.length > 0 ? (
                    <Button size="sm" busy={busy} disabled={!online} onClick={() => void read(group)}>
                      Read again
                    </Button>
                  ) : null}
                </>
              }
            >
              {known.length === 0 ? (
                <div className="unread">
                  <span className="muted">
                    Not read yet: {plural(names.length, "value")}, one request each, a few seconds apiece over the air.
                  </span>
                  <Button size="sm" busy={busy} disabled={!online} onClick={() => void read(group)}>
                    Read {plural(names.length, "value")}
                  </Button>
                </div>
              ) : (
                <>
                  <div className="form-grid">
                    {group.id === "radio" && radio
                      ? RADIO_FIELDS.map((f) => (
                          <FieldInput key={f.name} nodeKey={key} field={f} value={shown(f.name)} dirty={dirty[f.name] !== undefined} problem={problems[f.name]} onChange={setField} />
                        ))
                      : null}
                    {group.fields
                      .filter((f) => stored[f.name] !== undefined)
                      .map((f) => (
                        <FieldInput key={f.name} nodeKey={key} field={f} value={shown(f.name)} dirty={dirty[f.name] !== undefined} problem={problems[f.name]} onChange={setField} />
                      ))}
                  </div>
                  {group.id === "radio" ? (
                    <p className="inline-warn">
                      <AlertIcon size={14} />
                      <span>
                        {radioValue
                          ? "This moves the node off your channel. Apply offers a trial first, from which it falls back by itself."
                          : "Frequency, bandwidth, SF and CR must match your radio's, or the node goes silent to you."}
                      </span>
                    </p>
                  ) : null}
                </>
              )}
            </Section>
          );
        })}

        <Section title="Admin password">
          <div className="form-grid">
            <label className="field">
              <span className="field-label">New admin password</span>
              <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              <span className={["field-hint", passwordTooLong ? "danger" : ""].join(" ")}>
                {passwordTooLong ? `Sign-in reads only ${MAX_PASSWORD_LEN} bytes; keep it shorter.` : "Write-only: the node never sends it back."}
              </span>
            </label>
          </div>
          <div className="row-actions">
            <Button disabled={!online || !password || passwordTooLong} onClick={() => setAsk("password")}>
              Change password
            </Button>
          </div>
        </Section>
      </div>

      {total > 0 ? (
        <div className="apply-bar">
          {showCommands ? (
            <ul className="cmd-list">
              {commands.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          ) : null}
          {radioValue ? (
            <p className="inline-warn">
              <AlertIcon size={14} />
              <span>
                The node leaves this channel. <b>Try for {TRIAL_MINUTES} min</b> uses <code>tempradio</code>: unless you reach it on the new settings, it
                comes back by itself.
              </span>
            </p>
          ) : null}
          <div className="apply-row">
            <span>
              <b>{total}</b> {total === 1 ? "change" : "changes"} ·{" "}
              <button type="button" className="link" onClick={() => setShowCommands((s) => !s)}>
                {showCommands ? "Hide" : "Show"} commands
              </button>
            </span>
            <span className="row-actions">
              <Button size="sm" variant="ghost" disabled={applying} onClick={() => setDirty({})}>
                Discard
              </Button>
              {radioValue ? (
                <>
                  <Button size="sm" variant="danger" disabled={!online || invalid || applying} onClick={() => setAsk("radio")}>
                    Apply for good
                  </Button>
                  <Button size="sm" variant="primary" busy={applying} disabled={!online || invalid} onClick={() => void apply("trial")}>
                    Try for {TRIAL_MINUTES} min
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="primary" busy={applying} disabled={!online || invalid} onClick={() => void apply(null)}>
                  Apply {plural(total, "command")}
                </Button>
              )}
            </span>
          </div>
        </div>
      ) : null}

      <Confirm
        open={ask === "radio"}
        title="Move the node for good?"
        body={
          <p>
            {contact.name} will keep the new radio settings from its next reboot. If this radio is not on the same settings then, you lose it until someone reaches it on
            site. The {TRIAL_MINUTES}-minute trial is the safer first step.
          </p>
        }
        confirmLabel="Apply for good"
        danger
        onCancel={() => setAsk(null)}
        onConfirm={async () => {
          setAsk(null);
          await apply("save");
        }}
      />
      <Confirm
        open={ask === "password"}
        title="Change the admin password?"
        body={
          <p>
            From now on {contact.name} takes only the new password for admin sign-in.
            {hasSavedPassword(key) ? " The saved one is replaced as soon as the node confirms." : " Keep it somewhere: nothing here remembers it unless you sign in with Remember on."}
          </p>
        }
        confirmLabel="Change password"
        onCancel={() => setAsk(null)}
        onConfirm={async () => {
          setAsk(null);
          await changePassword();
        }}
      />
    </>
  );
}

function FieldInput({
  nodeKey,
  field,
  value,
  dirty,
  problem,
  onChange,
}: {
  nodeKey: string;
  field: SettingField;
  value: string;
  dirty: boolean;
  problem: string | undefined;
  onChange: (name: string, value: string) => void;
}) {
  const id = `setting-${nodeKey.slice(0, 8)}-${field.name}`;
  const className = ["input", dirty ? "dirty" : ""].join(" ");
  if (field.kind === "toggle") {
    return (
      <label className={["toggle", "field", "wide", dirty ? "dirty" : ""].join(" ")} htmlFor={id}>
        <span className="toggle-text">
          <span>
            {field.label} <code className="muted small">{field.name}</code>
          </span>
          {field.hint ? <span className="field-hint">{field.hint}</span> : null}
        </span>
        <input id={id} type="checkbox" checked={value === "on"} onChange={(e) => onChange(field.name, e.target.checked ? "on" : "off")} />
      </label>
    );
  }
  let input: React.ReactNode;
  if (field.kind === "select") {
    const options = field.options?.includes(value) || !value ? field.options! : [value, ...field.options!];
    input = (
      <select id={id} className={`${className} select`} value={value} onChange={(e) => onChange(field.name, e.target.value)}>
        {options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    );
  } else if (field.kind === "textarea") {
    input = <textarea id={id} className={className} rows={2} value={value} onChange={(e) => onChange(field.name, e.target.value)} />;
  } else {
    input = (
      <input
        id={id}
        className={className}
        type={field.kind === "number" ? "number" : "text"}
        inputMode={field.kind === "number" ? "numeric" : /lat|lon|delay|af|freq/.test(field.name) ? "decimal" : undefined}
        value={value}
        onChange={(e) => onChange(field.name, e.target.value)}
      />
    );
  }
  return (
    <label className={["field", field.kind === "textarea" ? "wide" : "", dirty ? "dirty" : ""].join(" ")} htmlFor={id}>
      <span className="field-label">
        <span>{field.label}</span>
        {RADIO_FIELDS.includes(field) ? null : <code className="muted small">{field.name}</code>}
      </span>
      {input}
      {problem ? <span className="field-hint danger">{problem}</span> : field.hint ? <span className="field-hint">{field.hint}</span> : null}
    </label>
  );
}
