import { useEffect } from "react";
import { AdvType, type ContactRecord } from "@meshnet/meshcore";
import { ConnectView } from "./components/ConnectView.js";
import { Workspace } from "./components/Workspace.js";
import { bearingDeg, compass, distanceKm, formatDistance, hasPosition } from "./lib/geo.js";
import { useLink } from "./lib/link.js";
import { askPermissionOnce, nodeNotificationsWanted, notificationsWanted, notify, onNotificationClick } from "./lib/notify.js";
import { session, useSession } from "./lib/session.js";
import { titleOf } from "./lib/conversations.js";
import { getNav, openContact, openConversation } from "./lib/nav.js";

const KIND: Record<number, string> = {
  [AdvType.Chat]: "contact",
  [AdvType.Repeater]: "repeater",
  [AdvType.Room]: "room",
  [AdvType.Sensor]: "sensor",
};

/** "Heard for the first time", and how far and which way when both positions are known. */
function discoveredBody(contact: ContactRecord): string {
  const self = session.getState().self;
  if (self && hasPosition(self.lat, self.lon) && hasPosition(contact.lat, contact.lon)) {
    const km = distanceKm(self.lat, self.lon, contact.lat, contact.lon);
    const heading = compass(bearingDeg(self.lat, self.lon, contact.lat, contact.lon));
    return `Heard for the first time, ${formatDistance(km)} ${heading}.`;
  }
  return "Heard for the first time.";
}

export function App() {
  const state = useSession();
  const link = useLink();

  // A message that arrives while the window is elsewhere is announced by the
  // system. Watched here, once, rather than in a view that may not be mounted.
  useEffect(() => {
    let known = new Set(session.getState().messages.map((m) => m.id));
    return session.subscribe(() => {
      const current = session.getState();
      if (current.status !== "ready") return;
      const nav = getNav();
      for (const m of current.messages) {
        if (known.has(m.id) || m.direction !== "in") continue;
        const focused = document.hasFocus() && nav.section === "chats" && nav.conversation === m.conversation;
        if (!focused && notificationsWanted()) {
          const title = titleOf(current, m.conversation);
          notify(m.sender && m.conversation.startsWith("ch:") ? `${m.sender} in ${title}` : title, m.text, `c:${m.conversation}`);
        }
      }
      known = new Set(current.messages.map((m) => m.id));
    });
  }, []);

  // A node the radio hears for the first time.
  useEffect(
    () =>
      session.onDiscovered((contact) => {
        if (!nodeNotificationsWanted()) return;
        const name = contact.name || contact.prefix;
        notify(`New ${KIND[contact.type] ?? "node"}: ${name}`, discoveredBody(contact), `n:${contact.key}`);
      }),
    [],
  );

  // A click on a notice opens what it was about.
  useEffect(() => {
    onNotificationClick((tag) => {
      if (tag.startsWith("c:")) openConversation(tag.slice(2));
      else if (tag.startsWith("n:")) openContact(tag.slice(2));
    });
  }, []);

  // The phone asks for permission the first time a radio is connected.
  const ready = state.status === "ready";
  useEffect(() => {
    if (ready) void askPermissionOnce();
  }, [ready]);

  const showWorkspace = state.status === "ready" || (state.status === "closed" && state.self !== null && link.phase !== "idle");
  return showWorkspace ? <Workspace /> : <ConnectView />;
}
