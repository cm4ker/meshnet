import { useEffect, useState } from "react";
import { channelConversation, fromHex } from "@meshnet/meshcore";
import { openConversation } from "../lib/nav.js";
import { session, useSession } from "../lib/session.js";
import { act, toast } from "../lib/toast.js";
import { Confirm } from "../ui/Dialog.js";
import { ActionRow, Block, Group, LinkRow } from "../ui/List.js";
import { Avatar } from "./Avatar.js";
import { ChatNotices } from "./ChatNotices.js";
import { CopyIcon } from "./Icons.js";
import { Gone, ScreenHead, type Chrome } from "./ScreenHead.js";

/** A channel's own page, opened from its conversation: its name, its key, and leaving it. */
export function ChannelView({ index, chrome }: { index: number; chrome: Chrome }) {
  const state = useSession();
  const channel = state.channels.find((c) => c.index === index);
  const online = state.status === "ready";
  const [name, setName] = useState(channel?.name ?? "");
  const [removing, setRemoving] = useState(false);

  useEffect(() => setName(channel?.name ?? ""), [channel?.name]);

  if (!channel) return <Gone chrome={chrome} title="Channel" text="The radio no longer has this channel." />;

  const rename = () => {
    const next = name.trim();
    if (!next || next === channel.name) return setName(channel.name);
    void act(() => session.setChannel(channel.index, next, fromHex(channel.secret)), "Renamed");
  };

  return (
    <div className="screen">
      <ScreenHead chrome={chrome}>
        <span className="screen-name">Channel</span>
      </ScreenHead>
      <div className="screen-scroll">
        <div className="hero">
          <Avatar name={channel.name || `Channel ${channel.index}`} channel size={68} />
          <h1>{channel.name || `Channel ${channel.index}`}</h1>
          <span className="muted">Channel {channel.index} on the radio</span>
        </div>
        <ChatNotices conversation={channelConversation(channel.index)} direct={false} />
        <Group title="Name">
          <Block>
            <input
              className="input"
              value={name}
              maxLength={31}
              disabled={!online}
              aria-label="Channel name"
              onChange={(e) => setName(e.target.value)}
              onBlur={rename}
              onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
            />
          </Block>
        </Group>
        <Group title="Key" note="Everyone with this key reads the channel. Send it to the people you want in.">
          <LinkRow
            label={<span className="mono key-text">{channel.secret}</span>}
            trailing={<CopyIcon size={14} className="line-chev" />}
            onClick={() => void navigator.clipboard?.writeText(channel.secret).then(() => toast("Key copied"))}
          />
        </Group>
        {channel.index === 0 ? (
          <p className="group-note">The first channel stays on the radio.</p>
        ) : (
          <Group>
            <ActionRow label="Remove the channel" danger disabled={!online} onClick={() => setRemoving(true)} />
          </Group>
        )}
      </div>
      <Confirm
        open={removing}
        title={`Remove ${channel.name || `channel ${channel.index}`}?`}
        body={<p>The radio stops listening on it. Its messages stay on this device.</p>}
        confirmLabel="Remove"
        danger
        onCancel={() => setRemoving(false)}
        onConfirm={async () => {
          setRemoving(false);
          if (await act(() => session.clearChannel(channel.index), "Channel removed")) openConversation(null);
        }}
      />
    </div>
  );
}
