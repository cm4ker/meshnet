import { useMemo } from "react";
import { ago } from "../lib/format.js";
import { summarize } from "../lib/conversations.js";
import { useSession } from "../lib/session.js";
import { Avatar } from "./Avatar.js";

export function ChatList({ selected, onOpen }: { selected: string | null; onOpen: (id: string) => void }) {
  const state = useSession();
  const rows = useMemo(() => summarize(state), [state]);
  if (rows.length === 0) {
    return <div className="empty muted">No channels and nobody has written yet.</div>;
  }
  return (
    <ul className="list" role="list">
      {rows.map((row) => (
        <li key={row.id}>
          <button type="button" className={["row", selected === row.id ? "selected" : ""].join(" ")} onClick={() => onOpen(row.id)}>
            <Avatar name={row.title} type={row.contact?.type} channel={row.kind === "channel"} />
            <span className="row-main">
              <span className="row-top">
                <span className="row-title">{row.title}</span>
                {row.lastAt ? <span className="row-when muted">{ago(row.lastAt)}</span> : null}
              </span>
              <span className="row-bottom">
                <span className="row-sub muted">{row.preview ?? (row.kind === "channel" ? "Quiet so far." : "")}</span>
                {row.unread > 0 ? <span className="badge">{row.unread}</span> : null}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
