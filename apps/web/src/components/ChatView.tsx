import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AdvType, isConversationType, parseConversation, type MessageRecord, type SessionState } from "@meshnet/meshcore";
import { GEO, MENTION } from "../lib/composer.js";
import { messagesIn, titleOf } from "../lib/conversations.js";
import { nameOfHash, relaysOf } from "../lib/echoes.js";
import { dayLabel, timeOfDay } from "../lib/format.js";
import { openChannel, openMessage, openProfile, openRoute } from "../lib/nav.js";
import { usePress } from "../lib/press.js";
import { routeWords } from "../lib/routes.js";
import { session, useSession } from "../lib/session.js";
import { toast } from "../lib/toast.js";
import { IconButton } from "../ui/Button.js";
import { showMenu, type MenuItem } from "../ui/Menu.js";
import { Avatar } from "./Avatar.js";
import { Composer, type Reply } from "./Composer.js";
import { AlertIcon, CheckIcon, ChevronRightIcon, ClockIcon, CopyIcon, DoubleCheckIcon, InfoIcon, LocationIcon, LockIcon, NodesIcon, ReplyIcon, TrashIcon, WavesIcon } from "./Icons.js";
import { ScreenHead, type Chrome } from "./ScreenHead.js";

export function ChatView({ conversation, chrome, infoOpen, onInfo }: { conversation: string; chrome: Chrome; infoOpen?: boolean | undefined; onInfo?: () => void }) {
  const state = useSession();
  const messages = useMemo(() => messagesIn(state, conversation), [state, conversation]);
  const title = titleOf(state, conversation);
  const target = parseConversation(conversation);
  const contact = target.kind === "contact" ? state.contacts[target.key] : undefined;
  // A room relays many voices, so its messages are named like a channel's.
  const many = target.kind === "channel" || contact?.type === AdvType.Room;
  // A room takes posts only from those signed in to it.
  const locked = contact?.type === AdvType.Room && !state.logins[contact.key]?.ok;
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [reply, setReply] = useState<Reply | null>(null);
  const answer = useCallback((message: MessageRecord) => {
    if (message.sender) setReply({ name: message.sender, text: message.text });
  }, []);

  // Pinned to the bottom, as a chat is, unless the reader has scrolled up to read.
  const stuck = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, conversation]);
  // The keyboard coming up shrinks the list from below; the last message stays in sight.
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const keep = new ResizeObserver(() => {
      if (stuck.current) el.scrollTop = el.scrollHeight;
    });
    keep.observe(el);
    return () => keep.disconnect();
  }, []);

  useReveal(scroller, inner, (id) => {
    const message = messages.find((m) => m.id === id);
    if (message) answer(message);
  });

  // Who this is: the profile of the person or room, the page of the channel.
  const details = onInfo ?? (target.kind === "contact" ? () => openProfile(target.key) : target.kind === "channel" ? () => openChannel(target.index) : undefined);
  const route = contact && isConversationType(contact.type) ? routeWords(contact) : null;
  const me = state.self?.name ?? null;

  return (
    <div className="screen chat">
      <ScreenHead
        chrome={chrome}
        actions={
          onInfo ? (
            <IconButton label="Details · Ctrl+I" className={infoOpen ? "on" : ""} aria-pressed={infoOpen} onClick={onInfo}>
              <InfoIcon size={18} />
            </IconButton>
          ) : undefined
        }
      >
        <button type="button" className="chat-who" onClick={details} disabled={!details} aria-label={`About ${title}`}>
          <Avatar name={title} type={contact?.type} channel={target.kind === "channel"} size={32} />
        </button>
        <span className="screen-name-stack">
          <button type="button" className="chat-who screen-name" onClick={details} disabled={!details}>
            {title}
          </button>
          {route && contact ? (
            <button type="button" className={["chat-route", route.tone].join(" ")} onClick={() => openRoute(contact.key)}>
              {route.tone === "pinned" ? <WavesIcon size={12} /> : null}
              <span>{route.text}</span>
              <ChevronRightIcon size={11} />
            </button>
          ) : target.kind === "contact" && !contact ? (
            <span className="chat-route">not in the contacts</span>
          ) : null}
        </span>
      </ScreenHead>

      <div
        className="chat-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        <div className="chat-inner" ref={inner}>
          {messages.length === 0 ? <div className="empty muted">{target.kind === "channel" ? "Write first: everyone on the channel hears it." : "Nothing here yet."}</div> : null}
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
                  me={me}
                  onReply={many && m.direction === "in" && m.sender ? answer : undefined}
                  contacts={m.direction === "out" ? state.contacts : undefined}
                />
              </div>
            );
          })}
        </div>
      </div>

      {locked && contact ? (
        <footer className="compose">
          <button type="button" className="compose-login" onClick={() => openProfile(contact.key)}>
            <LockIcon size={16} /> Log in to {title} to post
          </button>
        </footer>
      ) : (
        <Composer
          conversation={conversation}
          title={title}
          reply={reply}
          onReplyDone={() => setReply(null)}
          onSent={() => {
            stuck.current = true;
          }}
        />
      )}
    </div>
  );
}

/** A message's text, with mentions and positions picked out; a mention of this radio stands out more. */
function richText(text: string, me: string | null): ReactNode {
  const pattern = new RegExp(`${MENTION.source}|${GEO.source}`, "g");
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(pattern)) {
    const start = m.index ?? 0;
    if (start > at) out.push(text.slice(at, start));
    if (m[1] !== undefined) {
      out.push(
        <span key={start} className={m[1] === me ? "mention me" : "mention"}>
          @{m[1]}
        </span>,
      );
    } else {
      out.push(
        <span key={start} className="geo" title={m[0]}>
          <LocationIcon size={12} />
          {m[2]}, {m[3]}
        </span>,
      );
    }
    at = start + m[0].length;
  }
  if (at === 0) return text;
  if (at < text.length) out.push(text.slice(at));
  return out.map((part, i) => <Fragment key={i}>{part}</Fragment>);
}

/** Signal and hops, which the bubble keeps out of sight until asked. */
function techOf(message: MessageRecord, relays: number): string {
  if (message.direction === "in") {
    const bits = [];
    if (message.snr !== null) bits.push(`${message.snr > 0 ? "+" : ""}${message.snr.toFixed(1)} dB`);
    if (message.hops !== null) bits.push(message.hops === 0 ? "direct" : `${message.hops} hop${message.hops === 1 ? "" : "s"}`);
    return bits.join(" · ");
  }
  const bits = [];
  if (message.flood) bits.push("flood");
  if (relays > 0) bits.push(`relayed · ${relays}`);
  return bits.join(" · ");
}

interface MessageProps {
  message: MessageRecord;
  showSender: boolean;
  me: string | null;
  onReply: ((message: MessageRecord) => void) | undefined;
  /** For a message of ours only: the relays that echoed it are named from them. */
  contacts: SessionState["contacts"] | undefined;
}

/**
 * One bubble. Memoised: a message arriving, or an echo of one, changes one record, and the
 * other bubbles of a long conversation have nothing new to draw.
 */
const Message = memo(function Message({ message, showSender, me, onReply: replyTo, contacts }: MessageProps) {
  const out = message.direction === "out";
  const [busy, setBusy] = useState(false);
  const onReply = replyTo ? () => replyTo(message) : undefined;
  const relays = out && contacts ? relaysOf(message.echoes, contacts) : [];
  const tech = techOf(message, relays.length);
  const retryable = out && (message.status === "unconfirmed" || message.status === "failed");
  const flood = retryable && session.retryFloods(message);

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

  const press = usePress((at) => {
    const items: (MenuItem | null)[] = [
      onReply ? { label: "Reply", icon: <ReplyIcon size={17} />, onSelect: onReply } : null,
      { label: "Copy the text", icon: <CopyIcon size={17} />, onSelect: () => void navigator.clipboard?.writeText(message.text).then(() => toast("Copied")) },
      retryable ? { label: flood ? "Send again by flood" : "Send again", icon: <AlertIcon size={17} />, air: true, onSelect: () => void retry() } : null,
      message.status === "queued" ? { label: "Don't send", icon: <TrashIcon size={17} />, danger: true, onSelect: () => session.discardQueued(message.id) } : null,
      { label: "How it travelled", icon: <NodesIcon size={17} />, onSelect: () => openMessage(message.conversation, message.id) },
    ];
    showMenu(
      items.filter((x): x is MenuItem => x !== null),
      { at },
    );
  });

  const relayTitle = relays.length && contacts ? `Relayed by ${relays.length}: ${relays.map((r) => nameOfHash(r.hash, contacts) ?? r.hash).join(", ")}` : undefined;

  return (
    <div className={["msg", out ? "out" : "in"].join(" ")} data-reply={onReply ? message.id : undefined}>
      <span className="msg-reply-cue" aria-hidden="true">
        <ReplyIcon size={16} />
      </span>
      <div className="msg-col">
        {/* A div, not a button: its text stays selectable for copying with a mouse. */}
        <div
          role="button"
          tabIndex={0}
          className="bubble"
          onClick={() => {
            // A click that ends a text selection is not a tap.
            if (String(window.getSelection?.() ?? "").length > 0) return;
            openMessage(message.conversation, message.id);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openMessage(message.conversation, message.id);
            }
          }}
          title={relayTitle}
          {...press}
        >
          {showSender && message.sender ? <span className="msg-sender">{message.sender}</span> : null}
          <span className="msg-text">{richText(message.text, me)}</span>
          <span className="msg-meta">
            {tech ? <span className="msg-tech">{tech} ·</span> : null}
            <span>{timeOfDay(message.timestamp)}</span>
            {out ? <Status message={message} /> : null}
          </span>
        </div>
        {retryable ? (
          <button type="button" className={["msg-retry", message.status === "failed" ? "danger" : "warn"].join(" ")} disabled={busy} onClick={() => void retry()} title={message.error ?? undefined}>
            <AlertIcon size={12} /> {message.status === "failed" ? "Failed · retry" : flood ? "Retry by flood" : "Retry"}
          </button>
        ) : null}
      </div>
      {tech ? (
        <span className="msg-reveal" aria-hidden="true">
          {tech.split(" · ").map((t) => (
            <span key={t}>{t}</span>
          ))}
        </span>
      ) : null}
    </div>
  );
});

function Status({ message }: { message: MessageRecord }) {
  switch (message.status) {
    case "queued":
      return (
        <span className="queued" title="Waiting for the radio; it goes as soon as the radio is back">
          <ClockIcon size={12} /> queued
        </span>
      );
    case "sending":
      return (
        <span title="Sending">
          <ClockIcon size={12} />
        </span>
      );
    case "sent":
    case "unconfirmed":
      return (
        <span title={message.ackTag ? "Sent; waiting for the acknowledgement" : "Sent"}>
          <CheckIcon size={13} />
        </span>
      );
    case "delivered":
      return (
        <span className="ok" title={message.roundTripMs ? `Acknowledged in ${(message.roundTripMs / 1000).toFixed(1)} s` : "Acknowledged"}>
          <DoubleCheckIcon size={14} />
        </span>
      );
    default:
      return null;
  }
}

/** How far a message is pulled right before letting go answers it. */
const REPLY_PULL = 56;
/** The strip at the left edge where a pull goes back instead (the phone's edge swipe, Workspace.tsx). */
const EDGE = 24;

/**
 * Pulling the conversation left, on a touch screen, shows every message's
 * signal and hops at once; letting go hides them again. Pulling one message
 * right, in a channel or a room, answers it.
 */
function useReveal(scroller: React.RefObject<HTMLDivElement | null>, inner: React.RefObject<HTMLDivElement | null>, onReply: (id: string) => void) {
  const replyRef = useRef(onReply);
  replyRef.current = onReply;
  useEffect(() => {
    const el = scroller.current;
    const body = inner.current;
    if (!el || !body) return;
    let start: { x: number; y: number } | null = null;
    let mode: "reveal" | "reply" | null = null;
    let row: HTMLElement | null = null;
    let pulled = 0;
    const down = (e: TouchEvent) => {
      const t = e.touches[0];
      // From the edge, the pull is Back's; the bubble under it stays put.
      start = t && e.touches.length === 1 && t.clientX >= EDGE ? { x: t.clientX, y: t.clientY } : null;
      row = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-reply]") : null;
      mode = null;
      pulled = 0;
    };
    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!start || !t) return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (!mode) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        if (Math.abs(dy) > Math.abs(dx) || (dx > 0 && !row)) {
          start = null;
          return;
        }
        mode = dx > 0 ? "reply" : "reveal";
        (mode === "reply" ? row! : body).style.transition = "none";
      }
      e.preventDefault();
      if (mode === "reveal") {
        body.style.transform = `translateX(${Math.max(-76, Math.min(0, dx))}px)`;
        return;
      }
      const reach = Math.max(0, Math.min(REPLY_PULL + 16, dx));
      if (reach >= REPLY_PULL && pulled < REPLY_PULL) navigator.vibrate?.(8);
      pulled = reach;
      row!.style.transform = `translateX(${reach}px)`;
      row!.style.setProperty("--pull", String(Math.min(1, reach / REPLY_PULL)));
    };
    const up = () => {
      if (mode === "reveal") {
        body.style.transition = "";
        body.style.transform = "";
      } else if (mode === "reply" && row) {
        row.style.transition = "";
        row.style.transform = "";
        row.style.removeProperty("--pull");
        if (pulled >= REPLY_PULL && row.dataset.reply) replyRef.current(row.dataset.reply);
      }
      start = null;
      mode = null;
      row = null;
    };
    el.addEventListener("touchstart", down, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", up);
    el.addEventListener("touchcancel", up);
    return () => {
      el.removeEventListener("touchstart", down);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", up);
      el.removeEventListener("touchcancel", up);
    };
  }, [scroller, inner]);
}
