import { useEffect } from "react";
import { AdvType, type ContactRecord } from "@meshnet/meshcore";
import { ConnectView } from "./components/ConnectView.js";
import { Workspace } from "./components/Workspace.js";
import { UpdatesDialog } from "./components/Updates.js";
import { bearingDeg, compass, distanceKm, formatDistance, hasPosition } from "./lib/geo.js";
import { useLink } from "./lib/link.js";
import { askPermissionOnce, conversationIsVisible, nodeNotificationsWanted, notificationsWanted, notify, onNotificationClick, tellWatch } from "./lib/notify.js";
import { session, useSession } from "./lib/session.js";
import { titleOf } from "./lib/conversations.js";
import { isWide } from "./lib/layout.js";
import { getNav, openConversation, openProfile, shownConversation } from "./lib/nav.js";

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

  // Announce messages unless their conversation is visible and focused.
  // Watched here, once, rather than in a view that may not be mounted.
  useEffect(() => {
    let known = new Set(session.getState().messages.map((m) => m.id));
    return session.subscribe(() => {
      const current = session.getState();
      if (current.status !== "ready") return;
      const nav = getNav();
      const shown = { section: nav.section, conversation: shownConversation(nav, isWide()) };
      for (const m of current.messages) {
        if (known.has(m.id) || m.direction !== "in") continue;
        const focused = conversationIsVisible(m.conversation, shown);
        if (!focused && notificationsWanted()) {
          const title = titleOf(current, m.conversation);
          const me = current.self?.name;
          const mentioned = !!me && m.text.includes(`@[${me}]`);
          const heading = mentioned
            ? `${m.sender ?? title} mentioned you${m.sender && m.sender !== title ? ` in ${title}` : ""}`
            : m.sender && m.conversation.startsWith("ch:")
              ? `${m.sender} in ${title}`
              : title;
          void notify(heading, m.text, `c:${m.conversation}`);
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
        void notify(`New ${KIND[contact.type] ?? "node"}: ${name}`, discoveredBody(contact), `n:${contact.key}`);
      }),
    [],
  );

  // A click on a notice opens what it was about.
  useEffect(() => {
    onNotificationClick((tag) => {
      if (tag.startsWith("c:")) openConversation(tag.slice(2));
      else if (tag.startsWith("n:")) openProfile(tag.slice(2), true);
    });
  }, []);

  // The iPhone's native watch learns the switches at every start.
  useEffect(() => { void tellWatch(); }, []);

  // Back on screen, the queue is read again: a phone suspends the page in the
  // background, and a "message waiting" push that arrived meanwhile may never
  // reach it. Reading an empty queue costs one short exchange.
  useEffect(() => {
    const resume = () => {
      if (document.visibilityState !== "visible" || session.getState().status !== "ready") return;
      session.syncMessages().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", resume);
    return () => document.removeEventListener("visibilitychange", resume);
  }, []);

  // The phone asks for permission the first time a radio is connected.
  const ready = state.status === "ready";
  useEffect(() => {
    if (ready) void askPermissionOnce();
  }, [ready]);

  const showWorkspace = state.status === "ready" || (state.status === "closed" && state.self !== null && link.phase !== "idle");
  return <>{showWorkspace ? <Workspace /> : <ConnectView />}<UpdatesDialog /></>;
}
