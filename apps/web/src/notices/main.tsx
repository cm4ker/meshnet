/**
 * The desktop shell's corner window (`notices.rs`): the app's own notices on
 * a computer, stacked in the corner the reader picked, in the app's theme.
 *
 * It keeps its cards itself. The main page hands one over through the shell
 * (`notice-card`) and takes it back once read (`notice-withdraw`); a card
 * leaves by itself after a few seconds, unless the pointer rests on the
 * stack or the reader is typing a reply. It tells the shell how tall the
 * stack is, and the shell places and shows the window, or hides it when the
 * last card is gone. What is done on a card goes back to the main page.
 *
 * A page of its own, not the app: it holds no radio and no history.
 */

import { StrictMode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { NoticeCard, NoticeReply } from "../components/NoticeCard.js";
import type { Card } from "../lib/notify.js";
import { initTheme, setPreference } from "../theme/store.js";
import { initTextSize, setTextSizePreference, type TextSizePreference } from "../theme/textSize.js";
import "../styles.css";

/** How long a card stays, ms. */
const STAY = 6000;
/** At most this many at once: a newer one pushes the oldest out. */
const MOST = 3;

interface Shown extends Card {
  /** When it goes, unless held. */
  until: number;
}

initTheme();
initTextSize();
// The reader changes the theme or the text size in the main window: this one follows.
window.addEventListener("storage", (e) => {
  if (e.key === "meshnet.theme") setPreference(e.newValue ?? "system");
  if (e.key === "meshnet.textSize" && e.newValue) setTextSizePreference(e.newValue as TextSizePreference);
});

function Notices() {
  const [cards, setCards] = useState<Shown[]>([]);
  const [corner, setCorner] = useState("br");
  const [hovered, setHovered] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const stack = useRef<HTMLDivElement>(null);
  const held = hovered || busy !== null;

  useEffect(() => {
    const stops = [
      listen<{ card: Card; corner: string }>("notice-card", ({ payload }) => {
        setCorner(payload.corner);
        setCards((now) => {
          const card = { ...payload.card, until: Date.now() + STAY };
          const i = now.findIndex((c) => c.tag === card.tag);
          // The same chat's card is replaced where it is; a new one joins the end.
          const next = i >= 0 ? now.map((c, j) => (j === i ? card : c)) : [...now, card];
          return next.slice(-MOST);
        });
      }),
      listen<string>("notice-withdraw", ({ payload }) => setCards((now) => now.filter((c) => c.tag !== payload))),
    ];
    void Promise.all(stops).then(() => invoke("notice_ready"));
    return () => void stops.forEach((stop) => void stop.then((unlisten) => unlisten()));
  }, []);

  // Let go, every card has its full time again.
  useEffect(() => {
    if (!held) setCards((all) => (all.length ? all.map((c) => ({ ...c, until: Date.now() + STAY })) : all));
  }, [held]);

  // Cards go when their time is up; held, none does.
  useEffect(() => {
    if (cards.length === 0 || held) return;
    const next = Math.min(...cards.map((c) => c.until));
    const timer = setTimeout(() => setCards((all) => all.filter((c) => c.until > Date.now())), Math.max(0, next - Date.now()) + 20);
    return () => clearTimeout(timer);
  }, [cards, held]);

  // The window is as tall as the stack, and hidden with none. Hidden under the
  // pointer, it hears no "mouse left", so it lets go of the hold itself.
  useLayoutEffect(() => {
    const height = cards.length ? Math.ceil(stack.current?.getBoundingClientRect().height ?? 0) : 0;
    void invoke("notice_layout", { height }).catch(() => undefined);
    if (cards.length === 0) {
      setHovered(false);
      setBusy(null);
    }
  }, [cards]);

  const remove = (tag: string) => {
    setCards((all) => all.filter((c) => c.tag !== tag));
    setBusy((now) => (now === tag ? null : now));
  };
  // Bottom corners stack upwards, newest nearest the corner; top ones downwards.
  const top = corner.startsWith("t");
  const shown = top ? [...cards].reverse() : cards;

  return (
    <div ref={stack} className="notice-stack" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      {shown.map((card) => (
        <NoticeCard
          key={card.tag}
          title={card.title}
          body={card.body}
          face={card.face}
          onOpen={() => {
            remove(card.tag);
            void invoke("notice_open", { tag: card.tag });
          }}
          onClose={() => remove(card.tag)}
        >
          {card.chat ? (
            <NoticeReply
              onBusy={(on) => setBusy((now) => (on ? card.tag : now === card.tag ? null : now))}
              onReply={(text) => {
                remove(card.tag);
                void invoke("notice_act", { action: { action: "reply", tag: card.tag, text } });
              }}
              onRead={() => {
                remove(card.tag);
                void invoke("notice_act", { action: { action: "read", tag: card.tag } });
              }}
            />
          ) : null}
        </NoticeCard>
      ))}
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Notices />
    </StrictMode>,
  );
}
