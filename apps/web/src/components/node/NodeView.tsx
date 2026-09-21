import { useState } from "react";
import { aclRoleName } from "@meshnet/meshcore";
import { ADMIN_TABS, TAB_LABELS, hopsLabel, isAdmin, nodeKindName, nodeTabs, type NodeTab } from "../../lib/nodes.js";
import { forgetPassword, hasSavedPassword } from "../../lib/secrets.js";
import { session, useSession } from "../../lib/session.js";
import { Button, IconButton } from "../../ui/Button.js";
import { Confirm } from "../../ui/Dialog.js";
import { Avatar } from "../Avatar.js";
import { BackIcon, LockIcon } from "../Icons.js";
import { Access } from "./Access.js";
import { Console } from "./Console.js";
import { History } from "./History.js";
import { Neighbours } from "./Neighbours.js";
import { Overview } from "./Overview.js";
import { QueuePill } from "./QueuePill.js";
import { Settings } from "./Settings.js";
import { SignIn } from "./SignIn.js";

/** The tab each node was last left on, for as long as the page lives. */
const lastTab = new Map<string, NodeTab>();

export function NodeView({ nodeKey, onClose }: { nodeKey: string; onClose: () => void }) {
  const state = useSession();
  const contact = state.contacts[nodeKey];
  const [tab, setTabState] = useState<NodeTab>(lastTab.get(nodeKey) ?? "overview");
  const [signingIn, setSigningIn] = useState(false);
  const [forgetting, setForgetting] = useState(false);

  if (!contact) {
    return (
      <div className="card">
        <header className="chat-head">
          <IconButton label="Back" onClick={onClose}>
            <BackIcon size={18} />
          </IconButton>
          <span className="row-title">Node</span>
        </header>
        <div className="empty muted">This node is no longer in the radio's contacts.</div>
      </div>
    );
  }

  const login = state.logins[nodeKey];
  const admin = isAdmin(login);
  const tabs = nodeTabs(contact.type);
  const current = tabs.includes(tab) && (admin || !ADMIN_TABS.has(tab)) ? tab : "overview";
  const setTab = (next: NodeTab) => {
    lastTab.set(nodeKey, next);
    setTabState(next);
  };
  const role = login?.ok ? (login.role === null ? "signed in" : `signed in as ${aclRoleName(login.role)}`) : login ? "password refused" : "not signed in";

  let body: React.ReactNode;
  switch (current) {
    case "neighbours":
      body = <Neighbours contact={contact} />;
      break;
    case "history":
      body = <History contact={contact} />;
      break;
    case "settings":
      body = <Settings contact={contact} />;
      break;
    case "access":
      body = <Access contact={contact} />;
      break;
    case "console":
      body = <Console contact={contact} />;
      break;
    default:
      body = <Overview contact={contact} onSignIn={() => setSigningIn(true)} onForget={() => setForgetting(true)} />;
  }

  return (
    <div className="card node">
      <header className="chat-head node-head">
        <IconButton label="Back" onClick={onClose}>
          <BackIcon size={18} />
        </IconButton>
        <Avatar name={contact.name || contact.prefix} type={contact.type} size={32} />
        <div className="chat-title">
          <span className="row-title">{contact.name || contact.prefix}</span>
          <span className="muted small node-sub">
            {nodeKindName(contact.type)} · {role} · {hopsLabel(contact)}
          </span>
        </div>
        <QueuePill nodeKey={nodeKey} />
        {login?.ok ? (
          <Button size="sm" variant="ghost" className="node-signout" disabled={state.status !== "ready"} onClick={() => void session.logout(nodeKey).catch(() => undefined)}>
            Sign out
          </Button>
        ) : (
          <Button size="sm" variant="primary" disabled={state.status !== "ready"} onClick={() => setSigningIn(true)}>
            Sign in
          </Button>
        )}
      </header>
      <nav className="tabs" aria-label="Node sections">
        {tabs.map((t) => {
          const locked = ADMIN_TABS.has(t) && !admin;
          return (
            <button
              key={t}
              type="button"
              className={t === current ? "on" : ""}
              aria-current={t === current ? "page" : undefined}
              disabled={locked}
              title={locked ? "Needs the admin password" : undefined}
              onClick={() => setTab(t)}
            >
              {locked ? <LockIcon size={13} /> : null}
              {TAB_LABELS[t]}
            </button>
          );
        })}
      </nav>
      {body}

      <SignIn open={signingIn} nodeKey={nodeKey} onClose={() => setSigningIn(false)} onSignedIn={() => setSigningIn(false)} />
      <Confirm
        open={forgetting}
        title={`Forget ${contact.name || "this node"}?`}
        body={
          <p>
            It leaves the list, {hasSavedPassword(nodeKey) ? "its saved password is deleted, " : ""}and its status history goes. The node keeps its own record of this radio,
            so a later sign-in may need no password.
          </p>
        }
        confirmLabel="Forget"
        danger
        onCancel={() => setForgetting(false)}
        onConfirm={async () => {
          setForgetting(false);
          await forgetPassword(nodeKey).catch(() => undefined);
          await session.logout(nodeKey).catch(() => undefined);
          session.forgetNode(nodeKey);
          onClose();
        }}
      />
    </div>
  );
}
