import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { parseConversation, type MessageRecord } from "@meshnet/meshcore";
import { messagesIn, titleOf } from "../lib/conversations.js";
import { dayLabel, timeOfDay, utf8Length } from "../lib/format.js";
import { openContact } from "../lib/nav.js";
import { session, useSession } from "../lib/session.js";
import { IconButton } from "../ui/Button.js";
import { AlertIcon, BackIcon, CheckIcon, ClockIcon, DoubleCheckIcon, InfoIcon, SendIcon } from "./Icons.js";

export function ChatView({ conversation, onBack }: { conversation: string; onBack?: () => void }) {
  const state = useSession();
  const messages = useMemo(() => messagesIn(state, conversation), [state, conversation]);
  const title = titleOf(state, conversation);
  const target = parseConversation(conversation);
  const online = state.status === "ready";
  const scroller = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const budget = session.textBudget(conversation);
  const used = utf8Length(text);

  useEffect(() => {
    session.focus(conversation);
    return () => session.focus(null);
  }, [conversation]);

  // Pinned to the bottom, as a chat is, unless the reader has scrolled up to read.
  const stuck = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, conversation]);

  const send = async () => {
    const body = text.trim();
    if (!body || sending || used > budget) return;
    setSending(true);
    setError(null);
    try {
      await session.sendText(conversation, body);
      setText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const subtitle =
    target.kind === "channel"
      ? `Channel ${target.index}`
      : target.kind === "contact"
        ? describeContact(state.contacts[target.key]?.outPathLen)
        : "Not in the contacts yet";

  return (
    <div className="chat">
      <header className="chat-head">
        {onBack ? (
          <IconButton label="Back" onClick={onBack}>
            <BackIcon size={18} />
          </IconButton>
        ) : null}
        <div className="chat-title">
          <span className="row-title">{title}</span>
          <span className="muted small">{subtitle}</span>
        </div>
        {target.kind === "contact" ? (
          <IconButton label="Contact" onClick={() => openContact(target.key)}>
            <InfoIcon size={18} />
          </IconButton>
        ) : null}
      </header>

      <div
        className="chat-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {messages.length === 0 ? <div className="empty muted">Nothing here yet.</div> : null}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const newDay = !prev || dayLabel(prev.timestamp) !== dayLabel(m.timestamp);
          const sameSender = prev && !newDay && prev.direction === m.direction && prev.sender === m.sender && m.timestamp - prev.timestamp < 300;
          return (
            <div key={m.id}>
              {newDay ? <div className="day">{dayLabel(m.timestamp)}</div> : null}
              <Message message={m} showSender={target.kind === "channel" && m.direction === "in" && !sameSender} />
            </div>
          );
        })}
      </div>

      <footer className="composer">
        {error ? <div className="composer-error">{error}</div> : null}
        <div className="composer-row">
          <textarea
            className="composer-input"
            rows={1}
            placeholder={online ? `Message ${title}` : "Disconnected"}
            value={text}
            disabled={!online}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
          />
          <span className={["composer-count", used > budget ? "over" : ""].join(" ")}>
            {used}/{budget}
          </span>
          <IconButton label="Send" className="composer-send" disabled={!online || sending || !text.trim() || used > budget} onClick={() => void send()}>
            <SendIcon size={18} />
          </IconButton>
        </div>
      </footer>
    </div>
  );
}

function describeContact(outPathLen: number | undefined): string {
  if (outPathLen === undefined) return "";
  if (outPathLen === 0xff) return "No route known: messages flood";
  const hops = outPathLen & 63;
  return hops === 0 ? "Direct" : `${hops} hop${hops === 1 ? "" : "s"}`;
}

function Message({ message, showSender }: { message: MessageRecord; showSender: boolean }) {
  const out = message.direction === "out";
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    try {
      await session.retry(message.id);
    } catch {
      // The row shows the status.
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={["msg", out ? "out" : "in"].join(" ")}>
      <div className="bubble">
        {showSender && message.sender ? <div className="msg-sender">{message.sender}</div> : null}
        <div className="msg-text">{message.text}</div>
        <div className="msg-meta">
          <span>{timeOfDay(message.timestamp)}</span>
          {message.snr !== null ? <span title="Signal to noise">{message.snr.toFixed(1)} dB</span> : null}
          {message.hops !== null ? <span title="Hops">{message.hops === 0 ? "direct" : `${message.hops} hop${message.hops === 1 ? "" : "s"}`}</span> : null}
          {message.flood ? <span title="No route: flooded">flood</span> : null}
          {out ? <Status message={message} onRetry={retry} busy={busy} /> : null}
        </div>
      </div>
    </div>
  );
}

function Status({ message, onRetry, busy }: { message: MessageRecord; onRetry: () => void; busy: boolean }) {
  switch (message.status) {
    case "sending":
      return <ClockIcon size={13} />;
    case "sent":
      return message.ackTag ? (
        <span title="Sent; waiting for the acknowledgement">
          <CheckIcon size={13} />
        </span>
      ) : (
        <span title="Sent">
          <CheckIcon size={13} />
        </span>
      );
    case "delivered":
      return (
        <span className="ok" title={message.roundTripMs ? `Acknowledged in ${(message.roundTripMs / 1000).toFixed(1)} s` : "Acknowledged"}>
          <DoubleCheckIcon size={13} />
        </span>
      );
    case "unconfirmed":
      return (
        <button type="button" className="msg-retry warn" disabled={busy} onClick={onRetry} title="No acknowledgement. Send again">
          <AlertIcon size={13} /> retry
        </button>
      );
    case "failed":
      return (
        <button type="button" className="msg-retry danger" disabled={busy} onClick={onRetry} title={message.error ?? "Failed"}>
          <AlertIcon size={13} /> failed, retry
        </button>
      );
    default:
      return null;
  }
}
