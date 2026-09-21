import { useEffect, useRef, useState, type ReactNode } from "react";
import { summarize, totalUnread } from "../lib/conversations.js";
import { batteryPercent } from "../lib/format.js";
import { useLink } from "../lib/link.js";
import { useWide } from "../lib/layout.js";
import { back, focusOnMap, getNav, goSection, openConversation, setStack, shownConversation, topOf, useNav, type Nav, type Screen, type Section } from "../lib/nav.js";
import { isTauri } from "../lib/platform.js";
import { useSession } from "../lib/session.js";
import { MenuHost, ToastHost } from "../ui/Menu.js";
import { Sheet } from "../ui/Sheet.js";
import { ChannelView } from "./ChannelView.js";
import { ChatList, NEW_CHAT_EVENT } from "./ChatList.js";
import { ChatView } from "./ChatView.js";
import { ChatIcon, LinkIcon, NodesIcon, RadioIcon, SearchIcon } from "./Icons.js";
import { MeshList, MeshMap, MeshPhone, useMeshAttention } from "./Mesh.js";
import { MessageView } from "./MessageView.js";
import { NodePageView } from "./node/NodePage.js";
import { Palette } from "./Palette.js";
import { Profile } from "./Profile.js";
import { RadioHome } from "./RadioHome.js";
import { RadioPageView } from "./RadioPages.js";
import { RouteView } from "./RouteView.js";
import type { Chrome } from "./ScreenHead.js";

const SECTIONS: { id: Section; label: string; icon: ReactNode }[] = [
  { id: "chats", label: "Chats", icon: <ChatIcon size={22} /> },
  { id: "mesh", label: "Mesh", icon: <NodesIcon size={22} /> },
  { id: "radio", label: "Radio", icon: <RadioIcon size={22} /> },
];

export function Workspace() {
  const wide = useWide();
  return (
    <>
      {wide ? <Desktop /> : <Phone />}
      <MenuHost />
      <ToastHost />
    </>
  );
}

/** One screen of any section, laid out the same wherever it is shown. */
function ScreenView({ screen, chrome, wide }: { screen: Screen; chrome: Chrome; wide: boolean }) {
  switch (screen.kind) {
    case "chat":
      return <ChatView key={screen.conversation} conversation={screen.conversation} chrome={chrome} />;
    case "message":
      return <MessageView conversation={screen.conversation} id={screen.id} chrome={chrome} />;
    case "channel":
      return <ChannelView index={screen.index} chrome={chrome} />;
    case "profile":
      return <Profile key={screen.key} contactKey={screen.key} chrome={chrome} />;
    case "route":
      return <RouteView contactKey={screen.key} chrome={chrome} />;
    case "node":
      return <NodePageView key={`${screen.key}:${screen.page}`} contactKey={screen.key} page={screen.page} chrome={chrome} tabs={wide} />;
    case "radio":
      return <RadioPageView page={screen.page} chrome={chrome} />;
  }
}

/** The line that says the radio is gone, under every screen's header while it is. */
function Offline() {
  const state = useSession();
  const link = useLink();
  if (state.status === "ready") return null;
  return (
    <div className="offline" role="status">
      {link.phase === "connecting" ? (
        <>
          <span className="spinner" /> Reconnecting{link.attempt ? ` · attempt ${link.attempt}` : ""}
        </>
      ) : (
        <>Disconnected{link.error ? `: ${link.error}` : ""}</>
      )}
    </div>
  );
}

function useBadges() {
  const state = useSession();
  return { unread: totalUnread(state), attention: useMeshAttention(), offline: state.status !== "ready" };
}

// ---- the phone: one screen at a time, the tabs below ----

function Phone() {
  const nav = useNav();
  const badges = useBadges();
  const stack = nav.stacks[nav.section];
  const top = stack.at(-1) ?? null;
  // How a message travelled is a sheet over its conversation, not a screen of its own.
  const sheet = top?.kind === "message" ? top : null;
  const shown = sheet ? (stack.at(-2) ?? null) : top;
  const content = useRef<HTMLElement>(null);
  useEdgeSwipe(content, stack.length > 0 && !sheet);

  let screen: ReactNode;
  if (shown) screen = <ScreenView key={JSON.stringify(shown)} screen={shown} chrome={{ onBack: back }} wide={false} />;
  else if (nav.section === "chats") screen = <ChatList selected={null} />;
  else if (nav.section === "mesh") screen = <MeshPhone />;
  else screen = <RadioHome selected={null} />;

  // The conversation takes the whole height: its composer sits where the tabs were.
  const tabs = shown?.kind !== "chat";
  return (
    <div className={["app", "narrow", tabs ? "" : "detail"].join(" ")}>
      <main className="content" ref={content}>
        <Offline />
        {screen}
      </main>
      {tabs ? (
        <nav className="tabbar" aria-label="Sections">
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" className={nav.section === s.id ? "on" : ""} aria-current={nav.section === s.id ? "page" : undefined} onClick={() => goSection(s.id, nav.section === s.id)}>
              {s.icon}
              <span className="tab-label">{s.label}</span>
              <Badge section={s.id} badges={badges} />
            </button>
          ))}
        </nav>
      ) : null}
      <Sheet open={sheet !== null} onClose={back} title="How it travelled">
        {sheet ? <MessageView conversation={sheet.conversation} id={sheet.id} chrome={{}} bare /> : null}
      </Sheet>
    </div>
  );
}

function Badge({ section, badges }: { section: Section; badges: ReturnType<typeof useBadges> }) {
  if (section === "chats" && badges.unread > 0) return <span className="tab-badge">{badges.unread}</span>;
  if (section === "mesh" && badges.attention) return <span className="tab-dot warn" title="A node of yours needs a look" />;
  if (section === "radio" && badges.offline) return <span className="tab-dot bad" title="The radio is not connected" />;
  return null;
}

/**
 * A swipe from the left edge goes back, as on iOS; Android's own back
 * gesture arrives as a history step (see nav.ts). The screen follows the
 * finger, and goes if let go past a third of the way.
 */
function useEdgeSwipe(ref: React.RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    let start: { x: number; y: number } | null = null;
    let active = false;
    const screen = () => el.querySelector<HTMLElement>(":scope > .screen");
    const down = (e: TouchEvent) => {
      const t = e.touches[0];
      start = t && t.clientX < 24 && e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null;
      active = false;
    };
    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!start || !t) return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (!active) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        if (dx < 0 || Math.abs(dy) > Math.abs(dx)) {
          start = null;
          return;
        }
        active = true;
      }
      e.preventDefault();
      const s = screen();
      if (s) {
        s.style.transition = "none";
        s.style.transform = `translateX(${Math.max(0, dx)}px)`;
      }
    };
    const up = (e: TouchEvent) => {
      if (!active || !start) {
        start = null;
        return;
      }
      const t = e.changedTouches[0];
      const dx = t ? t.clientX - start.x : 0;
      const s = screen();
      start = null;
      active = false;
      if (!s) return;
      s.style.transition = "transform 0.18s ease-out";
      if (dx > el.clientWidth / 3) {
        s.style.transform = "translateX(100%)";
        setTimeout(back, 170);
      } else {
        s.style.transform = "";
      }
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
  }, [ref, enabled]);
}

// ---- the desktop: the list, what was picked in it, and a panel of details ----

/** How a desktop lays a section's stack out. */
function layout(nav: Nav) {
  const stack = nav.stacks[nav.section];
  const top = topOf(nav);
  if (nav.section === "chats") {
    const chat = stack.find((s): s is Extract<Screen, { kind: "chat" }> => s.kind === "chat") ?? null;
    const full = top?.kind === "node" ? top : null;
    const panel = !full && top && top.kind !== "chat" ? top : null;
    return { chat, full, panel, panelDepth: stack.filter((s) => s.kind !== "chat").length };
  }
  if (nav.section === "mesh") {
    const full = top?.kind === "node" ? top : null;
    const panel: Screen | null = full ? null : top ?? (nav.meshFocus ? { kind: "profile", key: nav.meshFocus } : null);
    return { chat: null, full, panel, panelDepth: stack.length };
  }
  return { chat: null, full: null, panel: null, panelDepth: 0 };
}

function Desktop() {
  const nav = useNav();
  const state = useSession();
  const badges = useBadges();
  const [palette, setPalette] = useState(false);
  const [group, setGroup] = useState<string[] | null>(null);
  const { chat, full, panel, panelDepth } = layout(nav);
  const radioPage = nav.section === "radio" ? (topOf(nav)?.kind === "radio" ? (topOf(nav) as Extract<Screen, { kind: "radio" }>).page : "name") : null;

  const closePanel = () => {
    if (nav.section === "chats") setStack("chats", chat ? [chat] : []);
    else setStack("mesh", [], { meshFocus: null });
  };
  const togglePanel = () => {
    if (nav.section !== "chats" || !chat) return;
    if (panel) return closePanel();
    const target = chat.conversation.startsWith("ch:") ? { kind: "channel" as const, index: Number(chat.conversation.slice(3)) } : chat.conversation.startsWith("c:") ? { kind: "profile" as const, key: chat.conversation.slice(2) } : null;
    if (target) setStack("chats", [chat, target]);
  };

  useDesktopKeys({ openPalette: () => setPalette(true), togglePanel, escape: full ? back : panel ? closePanel : null });

  let list: ReactNode;
  let main: ReactNode;
  if (nav.section === "chats") {
    list = <ChatList selected={chat?.conversation ?? null} />;
    main = full ? (
      <ScreenView screen={full} chrome={{ onBack: back }} wide />
    ) : chat ? (
      <ChatView key={chat.conversation} conversation={chat.conversation} chrome={{}} infoOpen={panel !== null} onInfo={togglePanel} />
    ) : (
      <Empty>Pick a conversation, or start one with +.</Empty>
    );
  } else if (nav.section === "mesh") {
    const focus = panel?.kind === "profile" || panel?.kind === "route" ? panel.key : full?.key ?? nav.meshFocus;
    list = <MeshList selected={focus ?? null} onOpen={(key) => { setGroup(null); setStack("mesh", [], { meshFocus: key }); }} />;
    main = full ? (
      <ScreenView screen={full} chrome={{ onBack: back }} wide />
    ) : (
      <MeshMap
        selected={focus ?? null}
        zoomButtons
        onSelect={(key) => {
          setGroup(null);
          if (key) setStack("mesh", [], { meshFocus: key });
          else focusOnMap(null);
        }}
        onGroup={(keys) => {
          setGroup(keys);
          setStack("mesh", [], { meshFocus: null });
        }}
      />
    );
  } else {
    list = <RadioHome selected={radioPage} />;
    main = <RadioPageView page={radioPage ?? "name"} chrome={{}} />;
  }

  const panelChrome: Chrome = { onClose: closePanel, onBack: panelDepth > 1 ? back : undefined };
  const groupPanel = nav.section === "mesh" && !panel && !full && group ? <GroupPanel keys={group} onClose={() => setGroup(null)} /> : null;

  return (
    <div className="app wide">
      <nav className="rail" aria-label="Sections">
        <button type="button" className="rail-search" title="Jump to anything · Ctrl+K" onClick={() => setPalette(true)}>
          <SearchIcon size={18} />
        </button>
        {SECTIONS.map((s, i) => (
          <button key={s.id} type="button" className={nav.section === s.id ? "on" : ""} aria-current={nav.section === s.id ? "page" : undefined} title={`${s.label} · ${isTauri() ? "Ctrl" : "Alt"}+${i + 1}`} onClick={() => goSection(s.id)}>
            {s.icon}
            <span className="tab-label">{s.label}</span>
            <Badge section={s.id} badges={{ ...badges, offline: false }} />
          </button>
        ))}
        <span className="grow" />
        <button type="button" className="rail-radio" title={state.link ? `${state.self?.name ?? "Radio"} · ${state.link.label}` : "The radio"} onClick={() => setStack("radio", [{ kind: "radio", page: "connection" }])}>
          {state.link ? <LinkIcon kind={state.link.kind} size={16} /> : <RadioIcon size={16} />}
          <span className={["dot", badges.offline ? "off" : "on"].join(" ")} aria-hidden="true" />
          <span className="tab-label">{state.battery ? `${batteryPercent(state.battery.mv)}%` : "—"}</span>
        </button>
      </nav>
      <aside className="pane">{list}</aside>
      <main className="content">
        <Offline />
        {main}
      </main>
      {panel && !full ? (
        <aside className="panel">
          <ScreenView key={JSON.stringify(panel)} screen={panel} chrome={panelChrome} wide />
        </aside>
      ) : groupPanel}
      <Palette open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}

function GroupPanel({ keys, onClose }: { keys: string[]; onClose: () => void }) {
  return (
    <aside className="panel">
      <div className="screen">
        <header className="screen-head">
          <div className="screen-title">
            <span className="screen-name">{keys.length} nodes at one spot</span>
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <MeshList selected={null} head={false} onOpen={(key) => { onClose(); setStack("mesh", [], { meshFocus: key }); }} only={keys} />
      </div>
    </aside>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="empty muted">{children}</div>;
}

/**
 * The desktop's keys. Ctrl+1–9 and Ctrl+N belong to a browser, so there the
 * sections are Alt+1–3 and a new chat is in the palette; the desktop shell
 * has both.
 */
function useDesktopKeys({ openPalette, togglePanel, escape }: { openPalette: () => void; togglePanel: () => void; escape: (() => void) | null }) {
  const state = useSession();
  const latest = useRef({ openPalette, togglePanel, escape, state });
  latest.current = { openPalette, togglePanel, escape, state };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector("dialog[open], .sheet-layer, .palette-layer, .popover")) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const { openPalette, togglePanel, escape, state } = latest.current;
      if (mod && key === "k") {
        e.preventDefault();
        openPalette();
      } else if ((e.altKey || (mod && isTauri())) && ["1", "2", "3"].includes(e.key)) {
        e.preventDefault();
        goSection(SECTIONS[Number(e.key) - 1]!.id);
      } else if (mod && key === "n" && isTauri()) {
        e.preventDefault();
        goSection("chats");
        setTimeout(() => window.dispatchEvent(new Event(NEW_CHAT_EVENT)));
      } else if (mod && key === "f") {
        const find = document.querySelector<HTMLInputElement>(".pane [data-find]");
        if (find) {
          e.preventDefault();
          find.focus();
          find.select();
        }
      } else if (mod && key === "i") {
        e.preventDefault();
        togglePanel();
      } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        const rows = summarize(state);
        const index = rows.findIndex((r) => r.id === shownConversation({ ...getNav(), section: "chats" }, true));
        const next = rows[Math.max(0, Math.min(rows.length - 1, index + (e.key === "ArrowDown" ? 1 : -1)))];
        if (next) openConversation(next.id);
      } else if (e.key === "Escape" && escape) {
        const target = e.target as HTMLElement | null;
        if (target?.closest("input, textarea, select")) return;
        e.preventDefault();
        escape();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
