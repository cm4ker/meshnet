/**
 * Where a message is written: one frame holding the text and its button, the
 * way a bubble holds a message, taking an outgoing bubble's colour once there
 * is something in it. What the message costs stays in sight: the frame's
 * lower edge fills as the 160 bytes run out, ticked where the cipher adds
 * another 16-byte block, and a tag above it gives the bytes and the time on
 * air. What does not fit is marked in the text itself, with two ways out.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AdvType, MAX_TEXT_LEN, parseConversation } from "@meshnet/meshcore";
import { costOf, blockEdges, geoText, hasCyrillic, headerBytes, mentionOf, mentionQuery, pathBytes, segments, splitParts, translit } from "../lib/composer.js";
import { messagesIn } from "../lib/conversations.js";
import { getDraft, setDraft } from "../lib/drafts.js";
import { utf8Length } from "../lib/format.js";
import { packLookalikes, useLookalikePrefs } from "../lib/lookalikes.js";
import { usePress } from "../lib/press.js";
import { session, useSession } from "../lib/session.js";
import { toast } from "../lib/toast.js";
import { showMenu, type MenuItem } from "../ui/Menu.js";
import { Avatar } from "./Avatar.js";
import { ClockIcon, CloseIcon, LocationIcon, ReplyIcon, SendIcon, TextIcon, WavesIcon } from "./Icons.js";

/** A message being answered: on the air, only its author's name before the text. */
export interface Reply {
  name: string;
  text: string;
}

const EDGES = blockEdges();
const share = (n: number) => `${(Math.min(n, MAX_TEXT_LEN) / MAX_TEXT_LEN) * 100}%`;

export function Composer({ conversation, title, reply, onReplyDone, onSent }: { conversation: string; title: string; reply: Reply | null; onReplyDone: () => void; onSent: () => void }) {
  const state = useSession();
  const lookalikes = useLookalikePrefs();
  const radio = state.self?.key ?? "";
  const [text, setText] = useState(() => getDraft(radio, conversation));
  const [focused, setFocused] = useState(false);
  const [pick, setPick] = useState<{ start: number; end: number; query: string; index: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [shake, setShake] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);

  const target = parseConversation(conversation);
  const contact = target.kind === "contact" ? state.contacts[target.key] : undefined;
  const online = state.status === "ready";
  const self = state.self;
  const pack = useCallback((t: string) => packLookalikes(t, lookalikes), [lookalikes]);
  const mention = reply ? mentionOf(reply.name) : "";
  const prefix = (target.kind === "channel" ? `${self?.name ?? ""}: ` : "") + mention;
  const header = target.kind === "channel" ? headerBytes("channel") : headerBytes("direct", contact ? pathBytes(contact.outPathLen) : 0);
  const shape = self ? { spreadingFactor: self.spreadingFactor, bandwidthHz: self.bandwidthHz, codingRate: self.codingRate } : null;
  const cost = costOf(text, { pack, prefix, header, radio: shape });
  const body = text.trim();
  const empty = body === "";
  const over = cost.over > 0;
  const tone = over ? "over" : cost.used >= cost.budget * 0.8 ? "warn" : "";

  const messages = useMemo(() => messagesIn(state, conversation), [state, conversation]);
  // Who can be named: whoever has written in this channel or room, the latest first.
  const many = target.kind === "channel" || contact?.type === AdvType.Room;
  const people = useMemo(() => {
    if (!many) return [];
    const seen = new Set<string>([self?.name ?? ""]);
    const out: string[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.direction !== "in" || !m.sender || seen.has(m.sender)) continue;
      seen.add(m.sender);
      out.push(m.sender);
    }
    return out;
  }, [many, messages, self?.name]);
  const matches = pick ? people.filter((n) => n.toLowerCase().includes(pick.query.toLowerCase())).slice(0, 6) : [];

  useEffect(() => setDraft(radio, conversation, text), [radio, conversation, text]);

  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    if (mirror.current) mirror.current.scrollTop = el.scrollTop;
  }, [text]);

  /** Puts `insert` over [from, to) as typing would, so that Undo takes it back. */
  const replace = (from: number, to: number, insert: string) => {
    const el = field.current;
    if (!el) {
      setText(text.slice(0, from) + insert + text.slice(to));
      return;
    }
    el.focus();
    el.setSelectionRange(from, to);
    if (!document.execCommand("insertText", false, insert)) {
      el.setRangeText(insert, from, to, "end");
      setText(el.value);
    }
  };

  const watchCaret = () => {
    const el = field.current;
    if (!el || people.length === 0 || el.selectionStart !== el.selectionEnd) {
      setPick(null);
      return;
    }
    const q = mentionQuery(el.value, el.selectionStart);
    setPick((prev) => (q ? { ...q, end: el.selectionStart, index: prev && prev.query === q.query ? prev.index : 0 } : null));
  };

  const name = (who: string) => {
    if (!pick) return;
    replace(pick.start, pick.end, mentionOf(who));
    setPick(null);
  };

  const nudge = () => setShake(true);

  const cleared = () => {
    setText("");
    setPick(null);
    onReplyDone();
    onSent();
  };

  const send = async (how: { raw?: boolean; flood?: boolean } = {}) => {
    if (empty) return;
    if (how.raw ? utf8Length(body) > cost.budget : over) {
      nudge();
      return;
    }
    const out = mention + (how.raw ? body : pack(body));
    cleared();
    try {
      await session.sendText(conversation, out, { original: mention + body, ...(how.flood ? { flood: true } : {}) });
    } catch {
      // The message's own row says it failed, and offers to try again.
    }
  };

  const sendSplit = async () => {
    const parts = splitParts(pack(body), cost.budget);
    const first = mention;
    cleared();
    for (const [i, part] of parts.entries()) {
      try {
        await session.sendText(conversation, (i === 0 ? first : "") + part);
      } catch {
        return;
      }
    }
  };

  const locate = () => {
    const put = (lat: number, lon: number) => replace(0, text.length, geoText(lat, lon));
    // The radio's own position is the fallback: set by hand or from GPS, it is where the radio said it was.
    const fallback = () => {
      if (self && (self.lat !== 0 || self.lon !== 0)) put(self.lat, self.lon);
      else toast("Neither this device nor the radio knows where it is", "error");
    };
    if (!("geolocation" in navigator)) return fallback();
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        put(pos.coords.latitude, pos.coords.longitude);
      },
      () => {
        setLocating(false);
        fallback();
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 },
    );
  };

  // Held, or right-clicked: the other ways to send this.
  const press = usePress((at) => {
    if (empty) return;
    const items: MenuItem[] = [];
    if (target.kind === "contact") items.push({ label: "Send by flood", icon: <WavesIcon size={17} />, air: true, hint: "Drops the route first", onSelect: () => void send({ flood: true }) });
    const extra = cost.typed - cost.used;
    if (extra > 0) {
      const fits = utf8Length(body) <= cost.budget;
      items.push({ label: "Send as typed", icon: <TextIcon size={17} />, air: true, disabled: !fits, hint: fits ? `Without lookalike letters, ${extra} B more` : "Too long without lookalike letters", onSelect: () => void send({ raw: true }) });
    }
    if (items.length > 0) showMenu(items, { at });
  });

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (pick && matches.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : matches.length - 1;
        setPick({ ...pick, index: (pick.index + step) % matches.length });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        name(matches[Math.min(pick.index, matches.length - 1)]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setPick(null);
        return;
      }
    }
    if (e.key === "Escape" && reply) {
      e.preventDefault();
      onReplyDone();
      return;
    }
    // A sent message cannot be edited on a mesh; the last one comes back to be corrected and sent again.
    if (e.key === "ArrowUp" && text === "") {
      const last = [...messages].reverse().find((m) => m.direction === "out");
      if (last) {
        e.preventDefault();
        replace(0, 0, last.original ?? last.text);
      }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  if (target.kind === "prefix") {
    return <footer className="compose compose-note muted">Not in the contacts yet: add the sender to write back.</footer>;
  }

  const placeholder = !online ? "Radio offline · sends when it's back" : target.kind === "channel" && target.index === 0 ? `Everyone on ${title} hears this` : `Message ${title}`;
  const saved = cost.typed - cost.used;
  const button = empty
    ? { cls: "pin", label: "Share my location", icon: <LocationIcon size={19} />, disabled: locating, act: locate }
    : over
      ? { cls: "over", label: "Too long to send", icon: <SendIcon size={18} />, disabled: true, act: () => undefined }
      : online
        ? { cls: "ready", label: "Send", icon: <SendIcon size={18} />, disabled: false, act: () => void send() }
        : { cls: "queue", label: "Send when the radio is back", icon: <ClockIcon size={18} />, disabled: false, act: () => void send() };
  const translitCost = over && hasCyrillic(text) ? utf8Length(pack(translit(text))) : null;
  const parts = over ? splitParts(pack(body), cost.budget).length : 0;

  return (
    <footer className={["compose", focused ? "focus" : "", text || reply ? "has" : "", online ? "" : "offline", shake ? "shake" : ""].join(" ")} onAnimationEnd={() => setShake(false)}>
      {matches.length > 0 && pick ? (
        <div className="compose-pop" role="listbox" aria-label="Mention">
          {matches.map((who, i) => (
            <button
              key={who}
              type="button"
              role="option"
              aria-selected={i === pick.index}
              className={i === pick.index ? "on" : ""}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => name(who)}
            >
              <Avatar name={who} size={24} />
              <span className="compose-pop-name">{who}</span>
              <span className="compose-cost">{utf8Length(mentionOf(who))} B</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="compose-box">
        {!empty && !(pick && matches.length > 0) ? (
          <span className={["compose-tag", tone].join(" ")} id={`cost-${conversation}`}>
            {over ? (
              `${cost.over} B over`
            ) : tone === "warn" ? (
              `${cost.used} / ${cost.budget} B`
            ) : (
              <>
                {cost.used} B{saved > 0 ? <span className="saved"> −{saved}</span> : null}
                {cost.airMs !== null ? ` · ${(cost.airMs / 1000).toFixed(2)} s` : ""}
              </>
            )}
          </span>
        ) : null}
        {reply ? (
          <div className="compose-bar">
            <ReplyIcon size={15} className="compose-bar-icon" />
            <span className="compose-bar-text">
              <b>{reply.name}</b> · {reply.text}
            </span>
            <span className="compose-cost">+{utf8Length(mention)} B</span>
            <button type="button" className="compose-bar-close" aria-label="Cancel the reply" onMouseDown={(e) => e.preventDefault()} onClick={onReplyDone}>
              <CloseIcon size={14} />
            </button>
          </div>
        ) : null}
        {over ? (
          <div className="compose-bar compose-over">
            <span className="compose-over-text">
              <b>{cost.over} B</b> too long · the radio takes {cost.budget}
            </span>
            <button type="button" className="chip" onMouseDown={(e) => e.preventDefault()} onClick={() => void sendSplit()}>
              Send in {parts}
            </button>
            {translitCost !== null ? (
              <button type="button" className="chip" onMouseDown={(e) => e.preventDefault()} onClick={() => replace(0, text.length, translit(text))}>
                Translit <span className="compose-cost">{translitCost <= cost.budget ? "fits" : `−${cost.used - translitCost} B`}</span>
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="compose-row">
          <div className="compose-field">
            <div className="compose-mirror" ref={mirror} aria-hidden="true">
              {segments(text, pack, cost.budget).map((s, i) => (
                <span key={i} className={[s.mention ? "men" : "", s.over ? "ovr" : ""].join(" ").trim() || undefined}>
                  {s.text}
                </span>
              ))}
              {"​"}
            </div>
            <textarea
              ref={field}
              rows={1}
              value={text}
              placeholder={placeholder}
              aria-label={`Message ${title}`}
              aria-describedby={empty ? undefined : `cost-${conversation}`}
              enterKeyHint="send"
              autoCapitalize="sentences"
              onChange={(e) => setText(e.target.value)}
              onSelect={watchCaret}
              onKeyDown={onKey}
              onScroll={(e) => {
                if (mirror.current) mirror.current.scrollTop = e.currentTarget.scrollTop;
              }}
              onFocus={() => setFocused(true)}
              onBlur={() => {
                setFocused(false);
                setPick(null);
              }}
            />
          </div>
          <button
            type="button"
            className={["compose-send", button.cls].join(" ")}
            aria-label={button.label}
            title={button.cls === "pin" ? "Share my location: puts it in the message as a geo: link" : undefined}
            disabled={button.disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={button.act}
            {...press}
          >
            {button.icon}
          </button>
        </div>
        <div className="compose-meter" aria-hidden="true">
          <i className={["fill", tone].join(" ")} style={{ width: share(cost.prefix + cost.used) }} />
          {EDGES.map((edge) => (
            <span key={edge} className="tick" style={{ left: share(edge) }} />
          ))}
        </div>
      </div>
    </footer>
  );
}
