import { useState } from "react";
import { AclRole, AdvType, NoReplyError, NodeCommandError, aclRoleName, isCliError, type ContactRecord } from "@meshnet/meshcore";
import { ago } from "../../lib/format.js";
import { session, useSession } from "../../lib/session.js";
import { Button } from "../../ui/Button.js";
import { Confirm } from "../../ui/Dialog.js";
import { Section } from "../../ui/Field.js";
import { Avatar } from "../Avatar.js";
import { RefreshIcon } from "../Icons.js";

const ROLES = [AclRole.Admin, AclRole.ReadWrite, AclRole.ReadOnly];

function message(e: unknown): string {
  if (e instanceof NoReplyError) return `${e.message}. The node may be out of range; try again.`;
  if (e instanceof NodeCommandError) return `The node said: ${e.reply}`;
  return (e as Error).message;
}

/**
 * Who may sign in, and as what. A role is set with `setperm`, which needs a
 * client's whole key to add or change one, so only contacts can be given a
 * role here; anyone listed can be removed by their prefix.
 */
export function Access({ contact }: { contact: ContactRecord }) {
  const state = useSession();
  const key = contact.key;
  const list = state.accessLists[key];
  const online = state.status === "ready";
  const selfPrefix = state.self?.prefix ?? "";
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [grantKey, setGrantKey] = useState("");
  const [grantRole, setGrantRole] = useState<number>(AclRole.ReadWrite);

  const run = async (name: string, action: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    setNote(null);
    try {
      await action();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  const setperm = async (target: string, permissions: number, label: string) => {
    const reply = await session.runCli(key, `setperm ${target} ${permissions}`);
    if (isCliError(reply)) throw new NodeCommandError(reply);
    await session.requestAccessList(key);
    setNote(label);
  };

  const people = Object.values(state.contacts)
    .filter((c) => c.type === AdvType.Chat && !list?.entries.some((e) => c.prefix === e.prefix))
    .sort((a, b) => a.name.localeCompare(b.name));
  const room = contact.type === AdvType.Room;

  return (
    <div className="card-scroll">
      <div className="toolbar">
        <span className="muted small">
          {list ? `${list.entries.length} ${room ? "admins" : "clients with a role"} · read ${ago(list.at)}` : "not asked yet"}
        </span>
        <Button size="sm" busy={busy === "list"} disabled={!online} onClick={() => void run("list", async () => void (await session.requestAccessList(key)))}>
          <RefreshIcon size={13} />
          {list ? "Refresh" : "Ask the node"}
        </Button>
      </div>
      {error ? <p className="connect-error">{error}</p> : null}
      {note ? <p className="muted small">{note}</p> : null}

      {list ? (
        <Section title="Who can sign in">
          {list.entries.length === 0 ? <p className="muted">Nobody but guests.</p> : null}
          <div className="acl">
            {list.entries.map((entry) => {
              const known = session.contactByPrefix(entry.prefix);
              const me = entry.prefix === selfPrefix;
              const name = me ? state.self?.name : known?.name;
              const role = entry.permissions & 3;
              return (
                <div className="acl-row" key={entry.prefix}>
                  <span className="who">
                    <Avatar name={name || entry.prefix} size={30} />
                    <span className="who-text">
                      <span>
                        {name || <code>{entry.prefix}</code>}
                        {me ? <span className="pill you">you</span> : null}
                      </span>
                      <span className="muted small">{name ? <code>{entry.prefix}</code> : "not in contacts"}</span>
                    </span>
                  </span>
                  <select
                    className="input select acl-role"
                    aria-label={`Role of ${name || entry.prefix}`}
                    value={role}
                    disabled={!online || me || busy !== null || (!known && !me)}
                    title={me ? "Your own role is not changed from here" : !known ? "A role change needs the whole key, which only a contact has" : undefined}
                    onChange={(e) => {
                      const next = (entry.permissions & ~3) | Number(e.target.value);
                      void run(entry.prefix, () => setperm(known!.key, next, `${name} is now ${aclRoleName(next)}.`));
                    }}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {aclRoleName(r)}
                      </option>
                    ))}
                  </select>
                  <Button size="sm" variant="ghost" busy={busy === entry.prefix} disabled={!online || me || busy !== null} onClick={() => setRemoving(entry.prefix)}>
                    Remove
                  </Button>
                </div>
              );
            })}
          </div>
        </Section>
      ) : (
        <p className="muted">One request brings back every client the node keeps a role for. Only admins may ask.</p>
      )}

      {list ? (
        <Section title="Give a contact a role">
          <div className="form-grid">
            <label className="field">
              <span className="field-label">Contact</span>
              <select className="input select" value={grantKey} onChange={(e) => setGrantKey(e.target.value)}>
                <option value="">Choose…</option>
                {people.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.name || p.prefix}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Role</span>
              <select className="input select" value={grantRole} onChange={(e) => setGrantRole(Number(e.target.value))}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {aclRoleName(r)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="row-actions">
            <Button
              busy={busy === "grant"}
              disabled={!online || !grantKey || busy !== null}
              onClick={() =>
                void run("grant", async () => {
                  const who = state.contacts[grantKey];
                  await setperm(grantKey, grantRole, `${who?.name ?? "The contact"} can sign in as ${aclRoleName(grantRole)} without a password.`);
                  setGrantKey("");
                })
              }
            >
              Give role
            </Button>
          </div>
          <p className="field-hint">A client with a role signs in with a blank password. Each change is one <code>setperm</code> command.</p>
        </Section>
      ) : null}

      <Confirm
        open={removing !== null}
        title="Remove from the list?"
        body={<p>They lose their role on {contact.name}, and sign in again only with a password.</p>}
        confirmLabel="Remove"
        danger
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          const prefix = removing!;
          setRemoving(null);
          await run(prefix, () => setperm(prefix, AclRole.Guest, "Removed."));
        }}
      />
    </div>
  );
}
