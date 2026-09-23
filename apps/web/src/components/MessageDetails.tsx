import { Fragment, useState, type ReactNode } from "react";
import type { ContactRecord, MessageEcho, MessageRecord } from "@meshnet/meshcore";
import { candidatesOfHash, nameOfHash, relaysOf } from "../lib/echoes.js";
import { ago, utf8Length } from "../lib/format.js";
import { openProfile } from "../lib/nav.js";
import { heardAt } from "../lib/nodes.js";
import { useSession } from "../lib/session.js";

/**
 * What is known of how a message travelled, shown under its bubble once it is
 * tapped. `peer` names the other end: the contact, or a channel message's
 * sender.
 */
export function MessageDetails({ message, peer }: { message: MessageRecord; peer: string }) {
  const { contacts } = useSession();
  const [pick, setPick] = useState<string | null>(null);
  const out = message.direction === "out";
  const channel = message.conversation.startsWith("ch:");
  const chain = (from: string, hashes: string[], to: string) => <HopChain from={from} hashes={hashes} to={to} contacts={contacts} pick={pick} onPick={setPick} />;

  let body: ReactNode = null;
  if (out && channel) {
    const relays = relaysOf(message.echoes, contacts);
    body =
      relays.length > 0 ? (
        <>
          <span className="details-lead">
            Relayed by {relays.length}: {relays.map((r) => r.name ?? `${r.hash}?`).join(", ")}
          </span>
          <span className="details-label">Copies heard back</span>
          <Copies echoes={message.echoes} contacts={contacts} />
        </>
      ) : (
        <Unheard message={message} />
      );
  } else if (out) {
    if (message.flood) {
      body = message.route ? (
        <>
          <span className="details-lead">Flooded. The acknowledgement came back along the route it took; the radio uses it for the next message.</span>
          {chain("You", message.route, peer)}
        </>
      ) : (
        <span>Flooded: no route was known. {message.status === "delivered" ? "No route came back with the acknowledgement." : "A route comes back with the acknowledgement."}</span>
      );
    } else if (message.route) {
      body = (
        <>
          <span className="details-label">Sent direct along</span>
          {chain("You", message.route, peer)}
        </>
      );
    }
  } else if (message.echoes.length > 0) {
    body = (
      <>
        <span className="details-label">Route of the copy delivered</span>
        {chain(peer, message.echoes[0]!.path, "You")}
        <span className="details-label">{message.echoes.length === 1 ? "1 copy heard" : `${message.echoes.length} copies heard`}</span>
        <Copies echoes={message.echoes} contacts={contacts} delivered />
      </>
    );
  } else if (message.hops === null) {
    body = (
      <>
        <span className="details-lead">Came by a direct route.</span>
        <span>Each relay strips itself from a direct packet's path, so it reaches the radio with none: who carried it cannot be told.</span>
      </>
    );
  } else {
    body = (
      <>
        <span className="details-lead">Route unknown.</span>
        <span>
          The radio handed up only the hop count ({message.hops}): the packet itself was not heard while the app was listening.
        </span>
      </>
    );
  }

  const candidates = pick ? candidatesOfHash(pick, contacts) : [];
  return (
    <div className="msg-details" onClick={(e) => e.stopPropagation()}>
      {body}
      {candidates.length > 1 ? (
        <div className="cands">
          <span>
            <b>{pick}</b> could be {candidates.length} contacts:
          </span>
          {candidates.map((c) => (
            <button key={c.key} type="button" className="link" onClick={() => openProfile(c.key)}>
              {c.name || c.prefix} · heard {ago(heardAt(c) || null)}
            </button>
          ))}
        </div>
      ) : null}
      <dl className="details-rows">
        {out ? (
          <>
            {message.original ? (
              <>
                <dt>Size</dt>
                <dd>
                  {utf8Length(message.text)} bytes on air, {utf8Length(message.original)} as typed: lookalike letters went as Latin
                </dd>
              </>
            ) : (
              <>
                <dt>Size</dt>
                <dd>{utf8Length(message.text)} bytes</dd>
              </>
            )}
            {message.roundTripMs ? (
              <>
                <dt>Acknowledged</dt>
                <dd>in {(message.roundTripMs / 1000).toFixed(1)} s</dd>
              </>
            ) : null}
            {message.attempt > 0 ? (
              <>
                <dt>Attempts</dt>
                <dd>{message.attempt + 1}</dd>
              </>
            ) : null}
          </>
        ) : (
          <>
            <dt>Sent</dt>
            <dd>{clock(message.timestamp * 1000)} by the sender's clock</dd>
            <dt>Received</dt>
            <dd>{clock(message.receivedAt)}</dd>
            <dt>Size</dt>
            <dd>{utf8Length(message.text)} bytes</dd>
          </>
        )}
      </dl>
    </div>
  );
}

/**
 * Ours on a channel with no echo yet. Worded around the repeaters only: a node
 * in direct range hears the message and sends nothing back, so silence is not
 * a miss.
 */
function Unheard({ message }: { message: MessageRecord }) {
  const plan = message.retryPlan;
  if (plan && plan.made < plan.total) {
    return (
      <>
        <span className="details-lead">
          Trying again: {plan.made} of {plan.total} sent.
        </span>
        <span>{plan.nextAt === null ? "Waiting for the radio; no try is spent while it is away." : "It stops at the first repeater heard sending it on."}</span>
      </>
    );
  }
  if (message.status === "unheard") {
    return (
      <>
        <span className="details-lead">{plan ? `${plan.total} tries, none relayed.` : "No repeater sent it on in the first 20 s."}</span>
        <span>A node in direct range may still have it. Repeaters out of range, asleep or busy stay quiet the same way.</span>
      </>
    );
  }
  return <span>No repeater has been heard sending it on.</span>;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** A route as a chain of chips: named relays open their contact, a hash several contacts share lists them. */
function HopChain({
  from,
  hashes,
  to,
  contacts,
  pick,
  onPick,
}: {
  from: string;
  hashes: string[];
  to: string;
  contacts: Record<string, ContactRecord>;
  pick: string | null;
  onPick: (hash: string | null) => void;
}) {
  return (
    <span className="hops">
      <span className="hop end">{from}</span>
      {hashes.map((hash, i) => {
        const matches = candidatesOfHash(hash, contacts);
        return (
          <Fragment key={i}>
            <span className="sep">›</span>
            {matches.length === 1 ? (
              <button type="button" className="hop" title="Open the contact" onClick={() => openProfile(matches[0]!.key)}>
                {matches[0]!.name} <span className="hop-hash">{hash}</span>
              </button>
            ) : matches.length > 1 ? (
              <button type="button" className={["hop amb", pick === hash ? "on" : ""].join(" ")} title={`${matches.length} contacts share this hash`} onClick={() => onPick(pick === hash ? null : hash)}>
                <span className="hop-hash">{hash}</span>?
              </button>
            ) : (
              <span className="hop" title="No contact has this hash">
                <span className="hop-hash">{hash}</span>
              </span>
            )}
          </Fragment>
        );
      })}
      <span className="sep">›</span>
      <span className="hop end">{to}</span>
    </span>
  );
}

/** Every copy heard, each with the relays it came through and how strong it was. */
function Copies({ echoes, contacts, delivered = false }: { echoes: MessageEcho[]; contacts: Record<string, ContactRecord>; delivered?: boolean }) {
  const label = (hash: string) => nameOfHash(hash, contacts) ?? `${hash}?`;
  return (
    <div className="copies">
      {echoes.map((echo, i) => (
        <div className="copy" key={i}>
          <span className="copy-path">
            {echo.path.length > 0 ? echo.path.map(label).join(" › ") : "heard direct"}
            {delivered && i === 0 ? <span className="copy-first"> delivered</span> : null}
          </span>
          <span className="snrbar" aria-hidden="true">
            <i style={{ width: `${Math.max(4, Math.min(100, ((echo.snr + 15) / 25) * 100))}%` }} />
          </span>
          <span className="copy-snr">
            {echo.snr > 0 ? "+" : ""}
            {echo.snr.toFixed(1)} dB
          </span>
        </div>
      ))}
    </div>
  );
}
