import { useEffect, useState, type FormEvent } from "react";
import { AdvType, MAX_PASSWORD_LEN, NoReplyError, aclRoleName } from "@meshnet/meshcore";
import { addableNodes, hopsLabel, nodeKindName } from "../../lib/nodes.js";
import { forgetPassword, hasSavedPassword, passwordStoreName, readPassword, savePassword, useSavedPasswords } from "../../lib/secrets.js";
import { session, useSession } from "../../lib/session.js";
import { Button } from "../../ui/Button.js";
import { Dialog } from "../../ui/Dialog.js";
import { Avatar } from "../Avatar.js";

/**
 * Signing in to a repeater, room or sensor; with no node given, picking one
 * from the contacts first. The password is kept when asked to, so the next
 * sign-in is one tap.
 */
export function SignIn({
  open,
  nodeKey,
  onClose,
  onSignedIn,
}: {
  open: boolean;
  nodeKey: string | null;
  onClose: () => void;
  onSignedIn: (key: string) => void;
}) {
  const state = useSession();
  const saved = useSavedPasswords();
  const [picked, setPicked] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const key = nodeKey ?? picked;
  const contact = key ? state.contacts[key] : undefined;
  const choices = nodeKey ? [] : addableNodes(state, saved);

  useEffect(() => {
    if (!open) return;
    setPicked(null);
    setPassword("");
    setError(null);
    setRemember(true);
    if (nodeKey && hasSavedPassword(nodeKey)) void readPassword(nodeKey).then((p) => p !== null && setPassword(p));
  }, [open, nodeKey]);

  const tooLong = new TextEncoder().encode(password).length > MAX_PASSWORD_LEN;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!key || !contact || tooLong) return;
    setBusy(true);
    setError(null);
    try {
      const login = await session.login(key, password);
      if (!login.ok) {
        setError(password ? "The node refused this password." : "The node does not know this radio, and a blank password lets no stranger in here.");
        return;
      }
      if (remember && password) await savePassword(key, password);
      else if (!remember) await forgetPassword(key);
      if (contact.type === AdvType.Repeater && (login.role === null || login.role === 3)) {
        // Who runs it and what it runs: asked once, while the route is fresh.
        void session.requestOwnerInfo(key).catch(() => undefined);
      }
      onSignedIn(key);
    } catch (err) {
      setError(
        err instanceof NoReplyError
          ? `No reply from ${contact.name || contact.prefix}. It may be out of range, or the route to it stale; try again.`
          : (err as Error).message,
      );
    } finally {
      setBusy(false);
    }
  };

  const title = nodeKey && contact ? `Sign in to ${contact.name || contact.prefix}` : "Add a node";
  const login = key ? state.logins[key] : undefined;

  return (
    <Dialog open={open} title={title} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {nodeKey ? null : (
          <div className="field">
            <span className="field-label">Repeaters, rooms and sensors in your contacts</span>
            {choices.length === 0 ? (
              <p className="muted small">Every one in your contacts is already in the list. Others appear in the contacts when their adverts are heard.</p>
            ) : (
              <div className="pick" role="listbox" aria-label="Node">
                {choices.map((c) => (
                  <button key={c.key} type="button" role="option" aria-selected={picked === c.key} className={picked === c.key ? "on" : ""} onClick={() => setPicked(c.key)}>
                    <Avatar name={c.name || c.prefix} type={c.type} size={28} />
                    <span className="who-text">
                      <span>{c.name || c.prefix}</span>
                      <span className="muted small">
                        {nodeKindName(c.type)} · {hopsLabel(c)}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <label className="field">
          <span className="field-label">Password</span>
          <input
            className="input"
            type="password"
            value={password}
            autoComplete="current-password"
            placeholder={contact?.type === AdvType.Sensor ? "admin password" : "admin or guest password"}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus={!!nodeKey}
          />
          <span className={["field-hint", tooLong ? "danger" : ""].join(" ")}>
            {tooLong ? `The node reads only the first ${MAX_PASSWORD_LEN} bytes; this one is longer.` : "Blank works when the node already knows this radio, or lets strangers read."}
          </span>
        </label>
        <label className="toggle">
          <span className="toggle-text">
            <span>Remember password</span>
            <span className="field-hint">Kept in {passwordStoreName()}.</span>
          </span>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        </label>
        {login && !login.ok && !error ? <p className="muted small">The last attempt was refused.</p> : null}
        {login?.ok && login.role !== null && !error ? <p className="muted small">Signed in as {aclRoleName(login.role)} last time.</p> : null}
        {error ? <p className="connect-error">{error}</p> : null}
        <div className="dialog-foot">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" busy={busy} disabled={!contact || tooLong || state.status !== "ready"}>
            Sign in
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
