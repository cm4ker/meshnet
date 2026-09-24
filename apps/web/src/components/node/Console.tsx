import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ConsoleEntry, ContactRecord } from "@meshnet/meshcore";
import { suggest } from "../../lib/cli.js";
import { timeOfDay } from "../../lib/format.js";
import { session, useSession } from "../../lib/session.js";
import { Button } from "../../ui/Button.js";
import { Confirm } from "../../ui/Dialog.js";

/** Commands that take a node down, move it, or lock people out. */
const DANGEROUS = /^(reboot|clkreboot|erase|start ota|poweroff|shutdown|set radio |password |set prv\.key|set guest\.password|setperm |set wifi\.(ssid|pwd) )/;

export function Console({ contact }: { contact: ContactRecord }) {
  const state = useSession();
  const key = contact.key;
  const entries = state.consoles[key] ?? [];
  const online = state.status === "ready";
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [recall, setRecall] = useState<number | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length, entries[entries.length - 1]?.status]);

  const send = (command: string) => {
    setDraft("");
    setRecall(null);
    // The entry shows how it went; nothing to add here.
    session.runCli(key, command).catch(() => undefined);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const command = draft.trim();
    if (!command) return;
    if (DANGEROUS.test(command)) setConfirming(command);
    else send(command);
  };

  const typed = draft.trim();
  const { chips, hint } = suggest(draft);

  const past = entries.filter((e) => e.command && !e.command.includes("••")).map((e) => e.command);
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // Tab takes the first suggestion, as a shell would.
    if (e.key === "Tab" && typed && chips[0]) {
      e.preventDefault();
      setDraft(chips[0].fill);
      return;
    }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    if (past.length === 0) return;
    e.preventDefault();
    const at = recall ?? past.length;
    const next = Math.max(0, Math.min(past.length, at + (e.key === "ArrowUp" ? -1 : 1)));
    setRecall(next === past.length ? null : next);
    setDraft(next === past.length ? "" : past[next]!);
  };

  return (
    <>
      <div className="console" ref={log} aria-live="polite">
        {entries.length === 0 ? (
          <p className="muted">
            Commands go to {contact.name || "the node"} over the air and wait their turn; replies land here, never in the chat. The node answers admins only.
          </p>
        ) : null}
        {entries.map((entry) => (
          <Entry key={entry.id} entry={entry} onRetry={() => send(entry.command)} />
        ))}
      </div>
      <form className="composer console-composer" onSubmit={submit}>
        <div className="chips console-chips">
          {chips.map((s) => (
            <button
              key={s.fill}
              type="button"
              className="chip mono"
              onClick={() => {
                setDraft(s.fill);
                input.current?.focus();
              }}
            >
              {s.label}
            </button>
          ))}
          {entries.length > 0 ? (
            <button type="button" className="chip" onClick={() => session.clearConsole(key)}>
              Clear
            </button>
          ) : null}
        </div>
        {hint ? <span className="console-hint mono">{hint}</span> : null}
        <div className="composer-row">
          <span className="prompt" aria-hidden="true">
            ›
          </span>
          <input
            ref={input}
            className="input mono"
            aria-label="Console command"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={online ? "Command, e.g. get tx" : "Disconnected"}
            value={draft}
            disabled={!online}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
          />
          <Button type="submit" variant="primary" disabled={!online || !typed}>
            Send
          </Button>
        </div>
      </form>
      <Confirm
        open={confirming !== null}
        title={`Send “${confirming ?? ""}”?`}
        body={
          <p>
            {confirming?.startsWith("set radio")
              ? "This moves the node off your channel from its next reboot. tempradio tries new settings for a while first."
              : confirming?.startsWith("password") || confirming?.startsWith("set guest.password")
                ? "Whoever signs in with the old password is refused from now on. The Settings tab changes the admin password and keeps the saved one in step."
                : `${contact.name} acts on it at once.`}
          </p>
        }
        confirmLabel="Send"
        danger
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          const command = confirming!;
          setConfirming(null);
          send(command);
        }}
      />
    </>
  );
}

function Entry({ entry, onRetry }: { entry: ConsoleEntry; onRetry: () => void }) {
  return (
    <div className="c-entry">
      {entry.command ? (
        <div className="c-cmd">
          <span className="c-prompt">›</span>
          <span>{entry.command}</span>
          <span className="c-tag" title="The tag the node echoes back">
            {entry.tag}|
          </span>
          <span className="c-time">{timeOfDay(entry.at / 1000)}</span>
        </div>
      ) : (
        <div className="c-cmd muted">
          <span className="c-prompt">‹</span>
          <span>unasked</span>
          <span className="c-time">{timeOfDay(entry.at / 1000)}</span>
        </div>
      )}
      {entry.status === "queued" ? (
        <div className="c-out c-wait">queued</div>
      ) : entry.status === "waiting" ? (
        <div className="c-out c-wait">
          <span className="spinner" aria-hidden="true" /> waiting for the reply…
        </div>
      ) : entry.status === "timeout" ? (
        <div className="c-out c-err">
          no reply
          {/* A masked command cannot be sent again: its text here is not the command. */}
          {entry.command.includes("••") ? null : (
            <>
              {" · "}
              <button type="button" className="link" onClick={onRetry}>
                Send again
              </button>
            </>
          )}
        </div>
      ) : entry.status === "failed" ? (
        <div className="c-out c-err">{entry.error}</div>
      ) : (
        <div className="c-out">{entry.reply}</div>
      )}
    </div>
  );
}
