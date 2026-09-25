import { kindLevel, setChatLevel, useNoticePrefs, type ChatLevel } from "../lib/noticePrefs.js";
import { Group, SelectRow } from "../ui/List.js";
import { BellIcon } from "./Icons.js";
import { t, type Key } from "../i18n/index.js";

const WORD: Record<ChatLevel, Key> = { all: "chats.notices.all", mentions: "chats.notices.mentions", off: "common.off" };
/** A person's chat is on or off: nobody mentions you in a chat that is only yours. */
const DIRECT_WORD: Record<ChatLevel, Key> = { all: "common.on", mentions: "common.on", off: "common.off" };

/** A chat's own notification level, on its channel page or its profile; "Default" follows Radio → Notifications. */
export function ChatNotices({ conversation, direct }: { conversation: string; direct: boolean }) {
  const prefs = useNoticePrefs();
  const own = prefs.chat[conversation];
  const words = direct ? DIRECT_WORD : WORD;
  const levels: ChatLevel[] = direct ? ["all", "off"] : ["all", "mentions", "off"];
  return (
    <Group>
      <SelectRow
        label={t("chats.notices.label")}
        icon={<BellIcon size={17} />}
        hint={own === "mentions" ? t("chats.notices.mentionsHint") : undefined}
        value={own ?? "default"}
        options={[{ value: "default", label: t("chats.notices.default", { level: t(words[kindLevel(prefs, direct)]) }) }, ...levels.map((l) => ({ value: l, label: t(words[l]) }))]}
        onChange={(v) => setChatLevel(conversation, v === "default" ? null : (v as ChatLevel))}
      />
    </Group>
  );
}
