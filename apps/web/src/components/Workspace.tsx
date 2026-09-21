import type { ReactNode } from "react";
import { useLink } from "../lib/link.js";
import { useWide } from "../lib/layout.js";
import { goSection, openContact, openConversation, useNav, type Section } from "../lib/nav.js";
import { useSession } from "../lib/session.js";
import { totalUnread } from "../lib/conversations.js";
import { ChatList } from "./ChatList.js";
import { ChatView } from "./ChatView.js";
import { ContactCard } from "./ContactCard.js";
import { ContactsList } from "./ContactsList.js";
import { ChatIcon, ContactsIcon, LogIcon, RadioIcon, SettingsIcon } from "./Icons.js";
import { LogView } from "./LogView.js";
import { RadioView } from "./RadioView.js";
import { SettingsView } from "./SettingsView.js";
import { StatusBar } from "./StatusBar.js";

const SECTIONS: { id: Section; label: string; icon: ReactNode }[] = [
  { id: "chats", label: "Chats", icon: <ChatIcon size={20} /> },
  { id: "contacts", label: "Contacts", icon: <ContactsIcon size={20} /> },
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
      {SECTIONS.map((s) => (
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
    const twoPane = nav.section === "chats" || nav.section === "contacts";
    return (
      <div className="app wide">
        {tabs}
        {twoPane ? (
          <>
            <aside className="pane">
              <StatusBar />
              {nav.section === "chats" ? (
                <ChatList selected={nav.conversation} onOpen={openConversation} />
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
  } else {
    screen = (
      <>
        <StatusBar />
        {banner}
        {nav.section === "chats" ? (
          <ChatList selected={null} onOpen={openConversation} />
        ) : nav.section === "contacts" ? (
          <ContactsList selected={null} onOpen={openContact} />
        ) : (
          <SectionBody section={nav.section} />
        )}
      </>
    );
  }
  const detail = (nav.section === "chats" && nav.conversation) || (nav.section === "contacts" && nav.contact);
  return (
    <div className={["app", "narrow", detail ? "detail" : ""].join(" ")}>
      <main className="content">{screen}</main>
      {detail ? null : tabs}
    </div>
  );
}

function SectionBody({ section }: { section: Section }) {
  switch (section) {
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
