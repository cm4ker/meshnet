import { useEffect, useMemo, useState, type FormEvent } from "react";
import { channelConversation, contactConversation, fromHex, isConversationType, isFavourite } from "@meshnet/meshcore";
import { freeChannelIndex, parseSecret, randomSecret } from "../lib/channels.js";
import { openConversation } from "../lib/nav.js";
import { kindLabel } from "../lib/nodes.js";
import { routeWords } from "../lib/routes.js";
import { session, useSession } from "../lib/session.js";
import { Button } from "../ui/Button.js";
import { Group, LinkRow } from "../ui/List.js";
import { Sheet } from "../ui/Sheet.js";
import { Avatar } from "./Avatar.js";
import { HashIcon, KeyIcon, PersonIcon, SearchIcon } from "./Icons.js";

type Step = "menu" | "people" | "create" | "join";

/** Three ways to start talking: to someone the radio has heard, on a new channel, or on one someone shared. */
export function NewChat({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [step, setStep] = useState<Step>("menu");
  useEffect(() => {
    if (open) setStep("menu");
  }, [open]);
  const title = step === "people" ? "Message someone" : step === "create" ? "Create a channel" : step === "join" ? "Join a channel" : "New chat";
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      {step === "menu" ? (
        <Group>
          <LinkRow icon={<PersonIcon size={18} />} label="Message someone" hint="A person or a room the radio has heard" onClick={() => setStep("people")} />
          <LinkRow icon={<HashIcon size={18} />} label="Create a channel" hint="A new key, to share with the people you want in" onClick={() => setStep("create")} />
          <LinkRow icon={<KeyIcon size={18} />} label="Join a channel" hint="With the name and key someone sent you" onClick={() => setStep("join")} />
        </Group>
      ) : step === "people" ? (
        <People onDone={onClose} />
      ) : (
        <ChannelForm join={step === "join"} onDone={onClose} />
      )}
    </Sheet>
  );
}

function People({ onDone }: { onDone: () => void }) {
  const state = useSession();
  const [query, setQuery] = useState("");
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(state.contacts)
      .filter((c) => isConversationType(c.type) && (!q || c.name.toLowerCase().includes(q)))
      .sort((a, b) => Number(isFavourite(b)) - Number(isFavourite(a)) || Math.max(b.lastHeardAt ?? 0, b.lastAdvert * 1000) - Math.max(a.lastHeardAt ?? 0, a.lastAdvert * 1000));
  }, [state.contacts, query]);
  return (
    <>
      <label className="search">
        <SearchIcon size={15} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find" aria-label="Find someone" autoFocus />
      </label>
      {rows.length === 0 ? (
        <p className="group-note">{query ? "Nobody by that name." : "Nobody yet: people appear when the radio hears their adverts."}</p>
      ) : (
        <ul className="list" role="list">
          {rows.map((c) => (
            <li key={c.key}>
              <button
                type="button"
                className="row"
                onClick={() => {
                  openConversation(contactConversation(c.key));
                  onDone();
                }}
              >
                <Avatar name={c.name || c.prefix} type={c.type} size={36} />
                <span className="row-main">
                  <span className="row-title">{c.name || c.prefix}</span>
                  <span className="row-sub muted">
                    {kindLabel(c.type)} · {routeWords(c).text}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function ChannelForm({ join, onDone }: { join: boolean; onDone: () => void }) {
  const state = useSession();
  const [name, setName] = useState("");
  const [key, setKey] = useState(() => (join ? "" : randomSecret()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const index = freeChannelIndex(state);
  const secret = parseSecret(key);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!secret || !name.trim() || index < 0) return;
    setBusy(true);
    setError(null);
    try {
      await session.setChannel(index, name.trim(), fromHex(secret));
      openConversation(channelConversation(index));
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (index < 0) return <p className="group-note">Every channel slot on the radio is taken. Remove one from its channel page first.</p>;

  return (
    <form className="stack sheet-form" onSubmit={submit}>
      <label className="field">
        <span className="field-label">Name</span>
        <input className="input" value={name} maxLength={31} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <label className="field">
        <span className="field-label">Key, 32 hex digits</span>
        <input className="input mono" value={key} onChange={(e) => setKey(e.target.value)} placeholder="paste the key here" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <span className={["field-hint", key && !secret ? "danger" : ""].join(" ")}>
          {key && !secret ? "A key is 16 bytes: 32 hex digits." : join ? "The same name and key as everyone on the channel." : "A random key. Copy it from the channel's page to invite people."}
        </span>
      </label>
      {error ? <p className="connect-error">{error}</p> : null}
      <Button variant="primary" size="lg" type="submit" busy={busy} disabled={!secret || !name.trim() || state.status !== "ready"}>
        {join ? "Join" : "Create"}
      </Button>
    </form>
  );
}
