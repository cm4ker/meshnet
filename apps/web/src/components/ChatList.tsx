import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { isFavourite, parseConversation } from "@meshnet/meshcore";
import { CHAT_ORDERS, changed, chatGroups, getChatOrder, setChatOrder, useChatOrder } from "../lib/chatOrder.js";
import { ago } from "../lib/format.js";
import { summarize, type ConversationSummary } from "../lib/conversations.js";
import { useDraft } from "../lib/drafts.js";
import { openConversation, setStack } from "../lib/nav.js";
import { useNoticePrefs } from "../lib/noticePrefs.js";
import { usePress, type MenuAt } from "../lib/press.js";
import { session, useSession } from "../lib/session.js";
import { toast } from "../lib/toast.js";
import { IconButton } from "../ui/Button.js";
import { Confirm } from "../ui/Dialog.js";
import { showMenu, type MenuItem } from "../ui/Menu.js";
import { Avatar } from "./Avatar.js";
import { BellOffIcon, CheckIcon, ChevronDownIcon, HashIcon, PersonIcon, PlusIcon, SearchIcon, SortIcon, StarFilledIcon, TrashIcon } from "./Icons.js";
import { NewChat } from "./NewChat.js";

/** Asks the chat list to open its New chat sheet, from a shortcut or the palette. */
export const NEW_CHAT_EVENT = "meshnet:new-chat";

export function ChatList({ selected }: { selected: string | null }) {
  const state = useSession();
  const rows = useMemo(() => summarize(state), [state]);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<ConversationSummary | null>(null);
  const order = useChatOrder();

  useEffect(() => {
    const open = () => setAdding(true);
    window.addEventListener(NEW_CHAT_EVENT, open);
    return () => window.removeEventListener(NEW_CHAT_EVENT, open);
  }, []);

  const q = query.trim().toLowerCase();
  const shown = q ? rows.filter((r) => r.title.toLowerCase().includes(q) || (r.preview ?? "").toLowerCase().includes(q)) : rows;
  const groups = chatGroups(shown, order);
  const unread = rows.filter((r) => r.unread > 0).length;

  return (
    <div className="list-pane">
      <header className="list-head">
        <h1>Chats</h1>
        <IconButton label="New chat" onClick={() => setAdding(true)}>
          <PlusIcon size={20} />
        </IconButton>
      </header>
      <label className="search">
        <SearchIcon size={15} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find" aria-label="Find a chat" data-find />
      </label>
      {rows.length === 0 ? (
        <div className="empty muted">No channels, and nobody has written yet.</div>
      ) : (
        <div className="list">
          <div className="list-summary muted">
            <span className="grow">
              {rows.length} {rows.length === 1 ? "chat" : "chats"}
              {unread ? ` · ${unread} unread` : ""}
            </span>
            <SortButton />
          </div>
          {shown.length === 0 ? (
            <div className="empty muted">Nothing matches.</div>
          ) : (
            groups.map((g) => (
              <Fragment key={g.title}>
                <div className="list-group">{g.title}</div>
                <ul className="list-rows" role="list">
                  {g.rows.map((row) => (
                    <ChatRow key={row.id} row={row} radio={state.self?.key ?? ""} selected={selected === row.id} onDelete={() => setDeleting(row)} />
                  ))}
                </ul>
              </Fragment>
            ))
          )}
        </div>
      )}
      <NewChat open={adding} onClose={() => setAdding(false)} />
      <Confirm
        open={deleting !== null}
        title={deleting?.kind === "channel" ? `Clear ${deleting.title}?` : `Delete the chat with ${deleting?.title ?? ""}?`}
        body={<p>{deleting?.kind === "channel" ? "Its messages are deleted from this device. The channel stays on the radio." : "Its messages are deleted from this device. The contact stays."}</p>}
        confirmLabel={deleting?.kind === "channel" ? "Clear" : "Delete"}
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) {
            session.deleteConversation(deleting.id);
            if (selected === deleting.id) openConversation(null);
            toast(deleting.kind === "channel" ? "Cleared" : "Deleted");
          }
          setDeleting(null);
        }}
      />
    </div>
  );
}

/** The list's order, named, and the menu that changes it. */
function SortButton() {
  const prefs = useChatOrder();
  const label = CHAT_ORDERS.find((o) => o.id === prefs.order)!;
  return (
    <button
      type="button"
      className={["sort-btn", changed(prefs) ? "changed" : ""].join(" ")}
      aria-label={`Sort chats, now by ${label.label.toLowerCase()}`}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        openSortMenu({ x: r.left, y: r.bottom + 4 });
      }}
    >
      <SortIcon size={14} />
      {label.short}
      <ChevronDownIcon size={12} />
    </button>
  );
}

/** Opened again after the switch flips, so the menu shows it flipped. */
function openSortMenu(at: MenuAt): void {
  const { order, channelsFirst } = getChatOrder();
  showMenu(
    [
      ...CHAT_ORDERS.map((o) => ({
        label: o.label,
        checked: o.id === order,
        onSelect: () => setChatOrder({ order: o.id }),
      })),
      {
        label: "Channels on top",
        hint: channelsFirst ? "Channels, then direct chats, each in the order above" : "One list, in the order above",
        toggle: true,
        checked: channelsFirst,
        group: true,
        onSelect: () => {
          setChatOrder({ channelsFirst: !channelsFirst });
          openSortMenu(at);
        },
      },
    ],
    { title: "Sort chats", at },
  );
}

function ChatRow({ row, radio, selected, onDelete }: { row: ConversationSummary; radio: string; selected: boolean; onDelete: () => void }) {
  const target = parseConversation(row.id);
  const draft = useDraft(radio, row.id);
  const press = usePress((at) => {
    const items: (MenuItem | null)[] = [
        target.kind === "channel"
          ? { label: "Channel", icon: <HashIcon size={17} />, onSelect: () => setStack("chats", [{ kind: "chat", conversation: row.id }, { kind: "channel", index: target.index }]) }
          : target.kind === "contact"
            ? { label: "Profile", icon: <PersonIcon size={17} />, onSelect: () => setStack("chats", [{ kind: "chat", conversation: row.id }, { kind: "profile", key: target.key }]) }
            : null,
        row.unread > 0 ? { label: "Mark as read", icon: <CheckIcon size={17} />, onSelect: () => session.markRead(row.id) } : null,
        { label: row.kind === "channel" ? "Clear messages" : "Delete chat", icon: <TrashIcon size={17} />, danger: true, onSelect: onDelete },
    ];
    showMenu(items.filter((x): x is MenuItem => x !== null), { title: row.title, at });
  });
  const swipe = useSwipe();
  const own = useNoticePrefs().chat[row.id];
  return (
    <li className="swipe" ref={swipe.ref}>
      <button type="button" className="swipe-action" tabIndex={-1} onClick={() => { swipe.close(); onDelete(); }}>
        {row.kind === "channel" ? "Clear" : "Delete"}
      </button>
      <button type="button" className={["row", selected ? "selected" : ""].join(" ")} onClick={() => (swipe.isOpen() ? swipe.close() : openConversation(row.id))} {...press}>
        <Avatar name={row.title} type={row.contact?.type} channel={row.kind === "channel"} size={44} />
        <span className="row-main">
          <span className="row-top">
            <span className="row-title">
              {row.title}
              {row.contact && isFavourite(row.contact) ? <StarFilledIcon size={11} className="star" /> : null}
              {own === "off" || own === "mentions" ? <BellOffIcon size={12} className="row-quiet" aria-label={own === "off" ? "Notifications off" : "Notifications for mentions only"} /> : null}
            </span>
            {row.lastAt ? <span className="row-when muted">{ago(row.lastAt)}</span> : null}
          </span>
          <span className="row-bottom">
            <span className="row-sub muted">
              {draft ? (
                <>
                  <span className="row-draft">Draft:</span> {draft}
                </>
              ) : (
                (row.preview ?? (row.kind === "channel" ? "Quiet so far." : ""))
              )}
            </span>
            {row.unread > 0 ? <span className="badge">{row.unread}</span> : null}
          </span>
        </span>
      </button>
    </li>
  );
}

const ACTION_W = 88;

/**
 * A row pulled left on a touch screen shows the action behind it. Touch
 * events, not pointer events: the list keeps scrolling vertically, and a
 * horizontal pull is claimed only once it is clearly one.
 */
function useSwipe() {
  const ref = useRef<HTMLLIElement>(null);
  const open = useRef(false);
  const row = () => ref.current?.querySelector<HTMLElement>(".row") ?? null;
  const set = (x: number, animate: boolean) => {
    const el = row();
    if (!el) return;
    el.style.transition = animate ? "" : "none";
    el.style.transform = x ? `translateX(${x}px)` : "";
  };
  useEffect(() => {
    const li = ref.current;
    if (!li) return;
    let start: { x: number; y: number } | null = null;
    let active = false;
    const base = () => (open.current ? -ACTION_W : 0);
    const down = (e: TouchEvent) => {
      const t = e.touches[0];
      start = t ? { x: t.clientX, y: t.clientY } : null;
      active = false;
    };
    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!start || !t) return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (!active) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        if (Math.abs(dy) > Math.abs(dx)) {
          start = null;
          return;
        }
        active = true;
      }
      e.preventDefault();
      set(Math.max(-ACTION_W - 24, Math.min(0, base() + dx)), false);
    };
    const up = (e: TouchEvent) => {
      if (!active || !start) return;
      const t = e.changedTouches[0];
      const x = base() + (t ? t.clientX - start.x : 0);
      open.current = x < -ACTION_W / 2;
      set(open.current ? -ACTION_W : 0, true);
      start = null;
      active = false;
    };
    li.addEventListener("touchstart", down, { passive: true });
    li.addEventListener("touchmove", move, { passive: false });
    li.addEventListener("touchend", up);
    li.addEventListener("touchcancel", up);
    return () => {
      li.removeEventListener("touchstart", down);
      li.removeEventListener("touchmove", move);
      li.removeEventListener("touchend", up);
      li.removeEventListener("touchcancel", up);
    };
  }, []);
  return {
    ref,
    isOpen: () => open.current,
    close: () => {
      open.current = false;
      set(0, true);
    },
  };
}
