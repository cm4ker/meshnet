import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { AdvType, isConversationType, parseConversation, type MessageRecord } from "@meshnet/meshcore";
import { messagesIn, titleOf } from "../lib/conversations.js";
import { nameOfHash, relaysOf } from "../lib/echoes.js";
import { dayLabel, timeOfDay, utf8Length } from "../lib/format.js";
import { packLookalikes, useLookalikePrefs } from "../lib/lookalikes.js";
import { openContact } from "../lib/nav.js";
import { routeSubtitle, useNow } from "../lib/routes.js";
import { session, useSession } from "../lib/session.js";
import { IconButton } from "../ui/Button.js";
import { AlertIcon, BackIcon, CheckIcon, ChevronDownIcon, ClockIcon, DoubleCheckIcon, InfoIcon, RepeaterIcon, SendIcon, WavesIcon } from "./Icons.js";
import { MessageDetails } from "./MessageDetails.js";
import { RouteDialog } from "./RouteDialog.js";

export function ChatView({ conversation, onBack }: { conversation: string; onBack?: () => void }) {
  const state = useSession();
  const now = useNow();
  const lookalikes = useLookalikePrefs();
  const messages = useMemo(() => messagesIn(state, conversation), [state, conversation]);
  const title = titleOf(state, conversation);
  const target = parseConversation(conversation);
  const contact = target.kind === "contact" ? state.contacts[target.key] : undefined;
  // A room relays many voices, so its messages are named like a channel's.
  const many = target.kind === "channel" || contact?.type === AdvType.Room;
  // Chats and rooms have their route governed; a repeater or a sensor is managed in Nodes.
  const routed = contact !== undefined && isConversationType(contact.type);
  const pinned = routed && session.routePolicy(contact.key).flood;
  const online = state.status === "ready";
  const scroller = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [routeOpen, setRouteOpen] = useState(false);
  const budget = session.textBudget(conversation);
  const packed = packLookalikes(text, lookalikes);
  const used = utf8Length(packed);
  const saved = utf8Length(text) - used;

  useEffect(() => {
    session.focus(conversation);
    setOpen(null);
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
      await session.sendText(conversation, packLookalikes(body, lookalikes), { original: body });
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

  const togglePin = async () => {
    if (!contact) return;
    setError(null);
    try {
      await session.setFloodPinned(contact.key, !pinned);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  let subtitle;
  if (target.kind === "channel") {
    subtitle = <span className="chat-sub">Channel {target.index}</span>;
  } else if (!contact) {
    subtitle = <span className="chat-sub">Not in the contacts yet</span>;
  } else if (routed) {
    const line = routeSubtitle(contact, now);
    subtitle = (
      <button type="button" className={["chat-sub", line.tone].join(" ")} onClick={() => setRouteOpen(true)} title="Route and flooding">
        {line.tone === "pinned" ? <WavesIcon size={13} /> : null}
        <span>{line.text}</span>
        <ChevronDownIcon size={12} />
      </button>
    );
  } else {
    subtitle = <span className="chat-sub">{routeSubtitle(contact, now).text}</span>;
  }

  const note = used > budget ? `${used - budget} bytes too long` : saved > 0 ? `Lookalike letters saved ${saved} bytes` : "";

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
          {subtitle}
        </div>
        {routed ? (
          <IconButton
            label={pinned ? "Always flood: on. Use learned routes again" : "Always flood"}
            className={pinned ? "on" : ""}
            aria-pressed={pinned}
            disabled={!online}
            onClick={() => void togglePin()}
          >
            <WavesIcon size={18} />
          </IconButton>
        ) : null}
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
              <Message
                message={m}
                showSender={many && m.direction === "in" && !sameSender}
                peer={m.direction === "in" && many ? (m.sender ?? "?") : title}
                open={open === m.id}
                onToggle={() => setOpen((current) => (current === m.id ? null : m.id))}
              />
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
          <IconButton label="Send" className="composer-send" disabled={!online || sending || !text.trim() || used > budget} onClick={() => void send()}>
            <SendIcon size={18} />
          </IconButton>
        </div>
        <div className="composer-meta">
          <span className={["composer-note", used > budget ? "over" : ""].join(" ")}>{note}</span>
          <span className={["composer-count", used > budget ? "over" : ""].join(" ")}>
            {used}/{budget}
          </span>
        </div>
      </footer>

      {contact && routed ? <RouteDialog contactKey={contact.key} open={routeOpen} onClose={() => setRouteOpen(false)} /> : null}
    </div>
  );
}

function Message({ message, showSender, peer, open, onToggle }: { message: MessageRecord; showSender: boolean; peer: string; open: boolean; onToggle: () => void }) {
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
  // A tap opens the details; a click that selects text, or lands on a control, does not.
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button, a")) return;
    if (String(window.getSelection?.() ?? "").length > 0) return;
    onToggle();
  };
  return (
    <div className={["msg", out ? "out" : "in"].join(" ")}>
      <div className={["bubble", "tappable", open ? "open" : ""].join(" ")} onClick={onClick}>
        {showSender && message.sender ? <div className="msg-sender">{message.sender}</div> : null}
        <div className="msg-text">{message.text}</div>
        <div className="msg-meta">
          <span>{timeOfDay(message.timestamp)}</span>
          {message.snr !== null ? <span title="Signal to noise">{message.snr.toFixed(1)} dB</span> : null}
          {message.hops !== null ? <span title="Hops">{message.hops === 0 ? "direct" : `${message.hops} hop${message.hops === 1 ? "" : "s"}`}</span> : null}
          {message.flood ? <span title="No route: flooded">flood</span> : null}
          {out && message.echoes.length > 0 ? <Relays message={message} /> : null}
          {out ? <Status message={message} onRetry={retry} busy={busy} /> : null}
        </div>
        {open ? <MessageDetails message={message} peer={peer} /> : null}
      </div>
    </div>
  );
}

/** How many nodes relayed a message of ours, from the copies the radio overheard. */
function Relays({ message }: { message: MessageRecord }) {
  const { contacts } = useSession();
  const relays = relaysOf(message.echoes, contacts);
  const title = `Relayed by ${relays.length}: ${relays.map((r) => nameOfHash(r.hash, contacts) ?? r.hash).join(", ")}`;
  return (
    <span className="msg-relays" title={title}>
      <RepeaterIcon size={13} /> {relays.length}
    </span>
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
    case "unconfirmed": {
      const flood = session.retryFloods(message);
      return (
        <button
          type="button"
          className="msg-retry warn"
          disabled={busy}
          onClick={onRetry}
          title={flood ? "No acknowledgement: the route may be gone. Drop it and send again by flood" : "No acknowledgement. Send again"}
        >
          <AlertIcon size={13} /> {flood ? "retry by flood" : "retry"}
        </button>
      );
    }
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
