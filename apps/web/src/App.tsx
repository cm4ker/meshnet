import { useEffect } from "react";
import { ConnectView } from "./components/ConnectView.js";
import { Workspace } from "./components/Workspace.js";
import { useLink } from "./lib/link.js";
import { notify } from "./lib/notify.js";
import { session, useSession } from "./lib/session.js";
import { titleOf } from "./lib/conversations.js";
import { getNav } from "./lib/nav.js";

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
        if (!focused) {
          const title = titleOf(current, m.conversation);
          notify(m.sender && m.conversation.startsWith("ch:") ? `${m.sender} in ${title}` : title, m.text, m.conversation);
        }
      }
      known = new Set(current.messages.map((m) => m.id));
    });
  }, []);

  const showWorkspace = state.status === "ready" || (state.status === "closed" && state.self !== null && link.phase !== "idle");
  return showWorkspace ? <Workspace /> : <ConnectView />;
}
