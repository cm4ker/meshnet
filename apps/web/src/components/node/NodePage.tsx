import { isNodeType } from "@meshnet/meshcore";
import { openNodePage, type NodePage } from "../../lib/nav.js";
import { isAdmin, nodeKindName } from "../../lib/nodes.js";
import { useSession } from "../../lib/session.js";
import { Avatar } from "../Avatar.js";
import { LockIcon } from "../Icons.js";
import { nodePages } from "../Profile.js";
import { Gone, ScreenHead, type Chrome } from "../ScreenHead.js";
import { Access } from "./Access.js";
import { Console } from "./Console.js";
import { History } from "./History.js";
import { Neighbours } from "./Neighbours.js";
import { QueuePill } from "./QueuePill.js";
import { Settings } from "./Settings.js";

const LABELS: Record<NodePage, string> = { neighbours: "Neighbours", history: "History", settings: "Settings", access: "Access", console: "Console" };
const ADMIN_ONLY = new Set<NodePage>(["settings", "access", "console"]);

/**
 * One of a node's own screens. On a phone it is pushed over the profile, one
 * page at a time; on a desktop it takes the width, with its sibling pages as
 * tabs, because a console and a settings form need room.
 */
export function NodePageView({ contactKey, page, chrome, tabs }: { contactKey: string; page: NodePage; chrome: Chrome; tabs: boolean }) {
  const state = useSession();
  const contact = state.contacts[contactKey];
  if (!contact || !isNodeType(contact.type)) return <Gone chrome={chrome} title={LABELS[page]} text="This node is no longer on the radio." />;
  const login = state.logins[contact.key];
  const admin = isAdmin(login);
  const name = contact.name || contact.prefix;
  const allowed = !!login?.ok && (!ADMIN_ONLY.has(page) || admin);

  let body: React.ReactNode;
  if (!allowed) body = <div className="empty muted">{login?.ok ? "This page needs the admin password: sign in again from the profile." : "Sign in from the profile first."}</div>;
  else if (page === "neighbours") body = <Neighbours contact={contact} />;
  else if (page === "history") body = <History contact={contact} />;
  else if (page === "settings") body = <Settings contact={contact} />;
  else if (page === "access") body = <Access contact={contact} />;
  else body = <Console contact={contact} />;

  return (
    <div className="screen node">
      <ScreenHead chrome={chrome} actions={<QueuePill nodeKey={contact.key} />}>
        <Avatar name={name} type={contact.type} size={28} />
        <span className="screen-name-stack">
          <span className="screen-name">{tabs ? name : LABELS[page]}</span>
          <span className="muted small">{tabs ? `${nodeKindName(contact.type)} · ${admin ? "signed in as admin" : login?.ok ? "signed in" : "not signed in"}` : name}</span>
        </span>
      </ScreenHead>
      {tabs ? (
        <nav className="tabs" aria-label={`${name}'s pages`}>
          {nodePages(contact.type).map((p) => {
            const locked = !login?.ok || (ADMIN_ONLY.has(p) && !admin);
            return (
              <button key={p} type="button" className={p === page ? "on" : ""} aria-current={p === page ? "page" : undefined} disabled={locked} title={locked ? "Needs the admin password" : undefined} onClick={() => openNodePage(contact.key, p)}>
                {locked ? <LockIcon size={13} /> : null}
                {LABELS[p]}
              </button>
            );
          })}
        </nav>
      ) : null}
      {body}
    </div>
  );
}
