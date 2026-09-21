import { lazy, Suspense, type ReactNode } from "react";
import { useLink } from "../lib/link.js";
import { useWide } from "../lib/layout.js";
import { goSection, openContact, openConversation, openNode, useNav, type Section } from "../lib/nav.js";
import { useSession } from "../lib/session.js";
import { totalUnread } from "../lib/conversations.js";
import { ChatList } from "./ChatList.js";
import { ChatView } from "./ChatView.js";
import { ContactCard } from "./ContactCard.js";
import { ContactsList } from "./ContactsList.js";
import { IconButton } from "../ui/Button.js";
import { BackIcon, ChatIcon, ContactsIcon, LogIcon, MapIcon, NodesIcon, RadioIcon, SettingsIcon } from "./Icons.js";
import { LogView } from "./LogView.js";
import { NodesList } from "./NodesList.js";
import { NodeView } from "./node/NodeView.js";
import { RadioView } from "./RadioView.js";
import { SettingsView } from "./SettingsView.js";
import { StatusBar } from "./StatusBar.js";

// Leaflet and its styles load with the map, not with the app.
const MapView = lazy(() => import("./MapView.js"));

const SECTIONS: { id: Section; label: string; icon: ReactNode }[] = [
  { id: "chats", label: "Chats", icon: <ChatIcon size={20} /> },
  { id: "contacts", label: "Contacts", icon: <ContactsIcon size={20} /> },
  { id: "map", label: "Map", icon: <MapIcon size={20} /> },
  { id: "nodes", label: "Nodes", icon: <NodesIcon size={20} /> },
  { id: "radio", label: "Radio", icon: <RadioIcon size={20} /> },
  { id: "log", label: "Log", icon: <LogIcon size={20} /> },
  { id: "settings", label: "Settings", icon: <SettingsIcon size={20} /> },
];

export function Workspace() {
  const wide = useWide();
  const nav = useNav();
  const state = useSession();
  const link = useLink();
  const unread = totalUnread(state);
  const offline = state.status !== "ready";

  const tabs = (
    <nav className={wide ? "rail" : "tabbar"} aria-label="Sections">
      {SECTIONS.filter((s) => wide || s.id !== "log").map((s) => (
        <button
          key={s.id}
          type="button"
          className={nav.section === s.id ? "on" : ""}
          aria-current={nav.section === s.id ? "page" : undefined}
          onClick={() => goSection(s.id)}
          title={s.label}
        >
          {s.icon}
          <span className="tab-label">{s.label}</span>
          {s.id === "chats" && unread > 0 ? <span className="tab-badge">{unread}</span> : null}
        </button>
      ))}
    </nav>
  );

  const banner = offline ? (
    <div className="banner">
      {link.phase === "connecting" ? (
        <>
          <span className="spinner" /> Reconnecting{link.attempt ? ` (attempt ${link.attempt})` : ""}…
        </>
      ) : (
        <>Disconnected{link.error ? `: ${link.error}` : ""}.</>
      )}
    </div>
  ) : null;

  if (wide) {
    const twoPane = nav.section === "chats" || nav.section === "contacts" || nav.section === "nodes";
    return (
      <div className="app wide">
        {tabs}
        {twoPane ? (
          <>
            <aside className="pane">
              <StatusBar />
              {nav.section === "chats" ? (
                <ChatList selected={nav.conversation} onOpen={openConversation} />
              ) : nav.section === "nodes" ? (
                <NodesList selected={nav.node} onOpen={openNode} />
              ) : (
                <ContactsList selected={nav.contact} onOpen={openContact} />
              )}
            </aside>
            <main className="content">
              {banner}
              {nav.section === "chats" ? (
                nav.conversation ? (
                  <ChatView conversation={nav.conversation} />
                ) : (
                  <Empty>Pick a conversation.</Empty>
                )
              ) : nav.section === "nodes" ? (
                nav.node ? (
                  <NodeView key={nav.node} nodeKey={nav.node} onClose={() => openNode(null)} />
                ) : (
                  <Empty>Pick a node, or add one with +.</Empty>
                )
              ) : nav.contact ? (
                <ContactCard contactKey={nav.contact} onClose={() => openContact(null)} />
              ) : (
                <Empty>Pick a contact.</Empty>
              )}
            </main>
          </>
        ) : (
          <main className="content single">
            <StatusBar />
            {banner}
            <SectionBody section={nav.section} />
          </main>
        )}
      </div>
    );
  }

  // The phone: one column, the tab bar below, a detail screen over the list.
  let screen: ReactNode;
  if (nav.section === "chats" && nav.conversation) {
    screen = <ChatView conversation={nav.conversation} onBack={() => openConversation(null)} />;
  } else if (nav.section === "contacts" && nav.contact) {
    screen = <ContactCard contactKey={nav.contact} onClose={() => openContact(null)} />;
  } else if (nav.section === "nodes" && nav.node) {
    screen = <NodeView key={nav.node} nodeKey={nav.node} onClose={() => openNode(null)} />;
  } else if (nav.section === "log") {
    // Six tabs fill a phone's bar, so the log gave its place to the map and opens from Radio.
    screen = (
      <div className="card">
        <header className="chat-head">
          <IconButton label="Back" onClick={() => goSection("radio")}>
            <BackIcon size={18} />
          </IconButton>
          <div className="chat-title">
            <span className="row-title">Log</span>
          </div>
        </header>
        <LogView />
      </div>
    );
  } else {
    screen = (
      <>
        <StatusBar />
        {banner}
        {nav.section === "chats" ? (
          <ChatList selected={null} onOpen={openConversation} />
        ) : nav.section === "contacts" ? (
          <ContactsList selected={null} onOpen={openContact} />
        ) : nav.section === "nodes" ? (
          <NodesList selected={null} onOpen={openNode} />
        ) : (
          <SectionBody section={nav.section} />
        )}
      </>
    );
  }
  const detail = (nav.section === "chats" && nav.conversation) || (nav.section === "contacts" && nav.contact) || (nav.section === "nodes" && nav.node) || nav.section === "log";
  return (
    <div className={["app", "narrow", detail ? "detail" : ""].join(" ")}>
      <main className="content">{screen}</main>
      {detail ? null : tabs}
    </div>
  );
}

function SectionBody({ section }: { section: Section }) {
  switch (section) {
    case "map":
      return (
        <Suspense fallback={<div className="empty muted">Loading the map…</div>}>
          <MapView />
        </Suspense>
      );
    case "radio":
      return <RadioView />;
    case "log":
      return <LogView />;
    case "settings":
      return <SettingsView />;
    default:
      return null;
  }
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="empty muted">{children}</div>;
}
