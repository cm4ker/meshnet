import { AdvType, parseConversation } from "@meshnet/meshcore";
import { titleOf } from "../lib/conversations.js";
import { useSession } from "../lib/session.js";
import { MessageDetails } from "./MessageDetails.js";
import { Gone, ScreenHead, type Chrome } from "./ScreenHead.js";

/**
 * How one message travelled, with the message quoted above it: a sheet over
 * the conversation on a phone, the panel beside it on a desktop.
 */
export function MessageView({ conversation, id, chrome, bare = false }: { conversation: string; id: string; chrome: Chrome; bare?: boolean | undefined }) {
  const state = useSession();
  const message = state.messages.find((m) => m.id === id);
  if (!message) return bare ? <div className="empty muted">This message is gone.</div> : <Gone chrome={chrome} title="Message" text="This message is gone." />;
  const target = parseConversation(conversation);
  const many = target.kind === "channel" || (target.kind === "contact" && state.contacts[target.key]?.type === AdvType.Room);
  const peer = message.direction === "in" && many ? (message.sender ?? "?") : titleOf(state, conversation);
  const body = (
    <>
      <blockquote className={["quote", message.direction].join(" ")}>
        {message.sender && message.direction === "in" ? <span className="msg-sender">{message.sender}</span> : null}
        {message.text}
      </blockquote>
      <MessageDetails message={message} peer={peer} />
    </>
  );
  if (bare) return <div className="message-body">{body}</div>;
  return (
    <div className="screen">
      <ScreenHead chrome={chrome}>
        <span className="screen-name">How it travelled</span>
      </ScreenHead>
      <div className="screen-scroll message-body">{body}</div>
    </div>
  );
}
