import { kindLevel, setChatLevel, useNoticePrefs, type ChatLevel } from "../lib/noticePrefs.js";
import { Group, SelectRow } from "../ui/List.js";
import { BellIcon } from "./Icons.js";

const WORD: Record<ChatLevel, string> = { all: "All", mentions: "Mentions", off: "Off" };
/** A person's chat is on or off: nobody mentions you in a chat that is only yours. */
const DIRECT_WORD: Record<ChatLevel, string> = { all: "On", mentions: "On", off: "Off" };

/** A chat's own notification level, on its channel page or its profile; "Default" follows Radio → Notifications. */
export function ChatNotices({ conversation, direct }: { conversation: string; direct: boolean }) {
  const prefs = useNoticePrefs();
  const own = prefs.chat[conversation];
  const words = direct ? DIRECT_WORD : WORD;
  const levels: ChatLevel[] = direct ? ["all", "off"] : ["all", "mentions", "off"];
  return (
    <Group>
      <SelectRow
        label="Notifications"
        icon={<BellIcon size={17} />}
        hint={own === "mentions" ? "Only when someone writes your name." : undefined}
        value={own ?? "default"}
        options={[{ value: "default", label: `Default (${words[kindLevel(prefs, direct)]})` }, ...levels.map((l) => ({ value: l, label: words[l] }))]}
        onChange={(v) => setChatLevel(conversation, v === "default" ? null : (v as ChatLevel))}
      />
    </Group>
  );
}
