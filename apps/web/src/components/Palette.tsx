import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useBackLayer } from "../lib/back.js";
import { summarize } from "../lib/conversations.js";
import { disconnect } from "../lib/link.js";
import { kindLabel } from "../lib/nodes.js";
import { goSection, openConversation, openProfile, openRadioPage, type RadioPage } from "../lib/nav.js";
import { session, useSession } from "../lib/session.js";
import { act } from "../lib/toast.js";
import { Avatar } from "./Avatar.js";
import { NEW_CHAT_EVENT } from "./ChatList.js";
import { AirIcon, PlusIcon, RefreshIcon, SearchIcon, SlidersIcon, LinkOffIcon } from "./Icons.js";
import { RADIO_TITLES } from "./RadioPages.js";

interface Item {
  group: string;
  label: string;
  hint?: string | undefined;
  icon: ReactNode;
  run: () => void;
}

/**
 * Ctrl+K: one field that finds a chat, a node or a setting by name, or runs
 * a command. Arrows move, Enter opens, Escape closes.
 */
export function Palette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const state = useSession();
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useBackLayer(open, onClose);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setAt(0);
    requestAnimationFrame(() => field.current?.focus());
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const online = state.status === "ready";
    const chats: Item[] = summarize(state).map((row) => ({ group: "Chats", label: row.title, hint: row.preview ?? undefined, icon: <Avatar name={row.title} type={row.contact?.type} channel={row.kind === "channel"} size={22} />, run: () => openConversation(row.id) }));
    const nodes: Item[] = Object.values(state.contacts).map((c) => ({ group: "Mesh", label: c.name || c.prefix, hint: kindLabel(c.type), icon: <Avatar name={c.name || c.prefix} type={c.type} size={22} />, run: () => openProfile(c.key, true) }));
    const pages: Item[] = (Object.keys(RADIO_TITLES) as RadioPage[]).map((page) => ({ group: "Radio", label: RADIO_TITLES[page], icon: <SlidersIcon size={16} />, run: () => openRadioPage(page) }));
    const commands: Item[] = [
      { group: "Commands", label: "New chat", icon: <PlusIcon size={16} />, run: () => { goSection("chats"); setTimeout(() => window.dispatchEvent(new Event(NEW_CHAT_EVENT))); } },
      ...(online
        ? [
            { group: "Commands", label: "Advertise nearby", hint: "zero hop", icon: <AirIcon size={16} />, run: () => void act(() => session.sendAdvert(false), "Advert sent to the neighbours") },
            { group: "Commands", label: "Advertise across the mesh", hint: "flood", icon: <AirIcon size={16} />, run: () => void act(() => session.sendAdvert(true), "Advert flooded across the mesh") },
            { group: "Commands", label: "Fetch every contact from the radio", icon: <RefreshIcon size={16} />, run: () => void act(() => session.refreshContacts(true), "Contacts fetched from the radio") },
          ]
        : []),
      { group: "Commands", label: "Disconnect", icon: <LinkOffIcon size={16} />, run: () => void disconnect() },
    ];
    return [...chats, ...nodes, ...pages, ...commands];
  }, [state]);

  const q = query.trim().toLowerCase();
  const shown = q ? items.filter((i) => i.label.toLowerCase().includes(q) || (i.hint ?? "").toLowerCase().includes(q)) : items;
  const pick = Math.min(at, Math.max(0, shown.length - 1));

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(".on")?.scrollIntoView({ block: "nearest" });
  }, [pick, query]);

  if (!open) return null;

  const run = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  let group = "";
  return createPortal(
    <div className="palette-layer" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Jump to">
        <label className="palette-field">
          <SearchIcon size={16} />
          <input
            ref={field}
            value={query}
            placeholder="Jump to a chat, a node, a setting, or run a command"
            aria-label="Jump to"
            onChange={(e) => {
              setQuery(e.target.value);
              setAt(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setAt(Math.min(pick + 1, shown.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setAt(Math.max(pick - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                run(shown[pick]);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                onClose();
              }
            }}
          />
        </label>
        <div className="palette-list" ref={list} role="listbox">
          {shown.length === 0 ? <div className="empty muted">Nothing by that name.</div> : null}
          {shown.map((item, i) => {
            const head = item.group !== group ? ((group = item.group), <div className="palette-group">{item.group}</div>) : null;
            return (
              <div key={`${item.group}:${item.label}:${i}`}>
                {head}
                <button type="button" role="option" aria-selected={i === pick} className={i === pick ? "on" : ""} onMouseMove={() => setAt(i)} onClick={() => run(item)}>
                  <span className="palette-icon">{item.icon}</span>
                  <span className="palette-label">{item.label}</span>
                  {item.hint ? <span className="palette-hint">{item.hint}</span> : null}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
