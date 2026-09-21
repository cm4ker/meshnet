import { useMemo, useState } from "react";
import { AdvType, contactHops, contactTypeName, isFavourite, type ContactRecord } from "@meshnet/meshcore";
import { ago } from "../lib/format.js";
import { session, useSession } from "../lib/session.js";
import { IconButton } from "../ui/Button.js";
import { Avatar } from "./Avatar.js";
import { RefreshIcon, StarFilledIcon } from "./Icons.js";

type Filter = "all" | "chat" | "repeater" | "room" | "favourite";

export function ContactsList({ selected, onOpen }: { selected: string | null; onOpen: (key: string) => void }) {
  const state = useSession();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(state.contacts)
      .filter((c) => {
        if (filter === "favourite" && !isFavourite(c)) return false;
        if (filter === "chat" && c.type !== AdvType.Chat) return false;
        if (filter === "repeater" && c.type !== AdvType.Repeater) return false;
        if (filter === "room" && c.type !== AdvType.Room) return false;
        if (q && !c.name.toLowerCase().includes(q) && !c.key.startsWith(q)) return false;
        return true;
      })
      .sort((a, b) => {
        const fa = isFavourite(a) ? 1 : 0;
        const fb = isFavourite(b) ? 1 : 0;
        if (fa !== fb) return fb - fa;
        return heard(b) - heard(a) || a.name.localeCompare(b.name);
      });
  }, [state.contacts, filter, query]);

  const refresh = async () => {
    setBusy(true);
    try {
      await session.refreshContacts(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="contacts">
      <div className="list-tools">
        <input className="input" placeholder="Find" value={query} onChange={(e) => setQuery(e.target.value)} />
        <IconButton label="Fetch all contacts from the radio" onClick={() => void refresh()} disabled={busy || state.status !== "ready"}>
          <RefreshIcon size={16} className={busy ? "spin" : ""} />
        </IconButton>
      </div>
      <div className="chips">
        {(["all", "favourite", "chat", "repeater", "room"] as Filter[]).map((f) => (
          <button key={f} type="button" className={["chip", filter === f ? "on" : ""].join(" ")} onClick={() => setFilter(f)}>
            {f === "all" ? "All" : f === "favourite" ? "Favourites" : f === "chat" ? "People" : f === "repeater" ? "Repeaters" : "Rooms"}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <div className="empty muted">{Object.keys(state.contacts).length === 0 ? "No contacts. Adverts from nearby radios will appear here." : "Nothing matches."}</div>
      ) : (
        <ul className="list" role="list">
          {rows.map((c) => (
            <li key={c.key}>
              <button type="button" className={["row", selected === c.key ? "selected" : ""].join(" ")} onClick={() => onOpen(c.key)}>
                <Avatar name={c.name || c.prefix} type={c.type} />
                <span className="row-main">
                  <span className="row-top">
                    <span className="row-title">
                      {c.name || c.prefix}
                      {isFavourite(c) ? <StarFilledIcon size={12} className="star" /> : null}
                    </span>
                    <span className="row-when muted">{ago(heard(c) || null)}</span>
                  </span>
                  <span className="row-bottom">
                    <span className="row-sub muted">
                      {contactTypeName(c.type)}
                      {hopsText(c)}
                    </span>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function heard(c: ContactRecord): number {
  return Math.max(c.lastHeardAt ?? 0, c.lastAdvert * 1000);
}

function hopsText(c: ContactRecord): string {
  const hops = contactHops(c);
  if (hops === null) return " · no route";
  return hops === 0 ? " · direct" : ` · ${hops} hop${hops === 1 ? "" : "s"}`;
}
