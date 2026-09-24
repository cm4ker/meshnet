import { Fragment, useState, type ReactNode } from "react";
import type { ContactRecord, MessageEcho, MessageRecord } from "@meshnet/meshcore";
import { candidatesOfHash, spreadOf } from "../lib/echoes.js";
import { ago, utf8Length } from "../lib/format.js";
import { quality } from "../lib/los.js";
import { openProfile } from "../lib/nav.js";
import { heardAt } from "../lib/nodes.js";
import { useSession } from "../lib/session.js";

/**
 * What is known of how a message travelled, shown under its bubble once it is
 * tapped. `peer` names the other end: the contact, or a channel message's
 * sender. Each thing takes one line: who heard it and how loud, and how far
 * it went; the chains of relays open on a tap.
 */
export function MessageDetails({ message, peer }: { message: MessageRecord; peer: string }) {
  const { contacts } = useSession();
  const [pick, setPick] = useState<string | null>(null);
  const out = message.direction === "out";
  const channel = message.conversation.startsWith("ch:");
  const chain = (from: string, hashes: string[], to: string) => <HopChain from={from} hashes={hashes} to={to} contacts={contacts} pick={pick} onPick={setPick} />;
  const relay = (hash: string) => <Relay hash={hash} contacts={contacts} pick={pick} onPick={setPick} />;

  let body: ReactNode = null;
  if (out && channel) {
    body = message.echoes.some((e) => e.path.length > 0) ? <Spread echoes={message.echoes} relay={relay} /> : <Unheard message={message} />;
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
    body = <Arrived echoes={message.echoes} relay={relay} />;
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

  const bytes = `${utf8Length(message.text)} bytes`;
  const facts = out
    ? [
        message.original ? `${bytes} · lookalike letters sent as Latin (${utf8Length(message.original)} typed)` : bytes,
        message.roundTripMs ? `acknowledged in ${(message.roundTripMs / 1000).toFixed(1)} s` : null,
        message.attempt > 0 ? `${message.attempt + 1} attempts` : null,
      ]
    : [`Sent ${clock(message.timestamp * 1000)} by their clock`, `received ${clock(message.receivedAt)}`, bytes];

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
      <span className="details-meta">{facts.filter(Boolean).join(" · ")}</span>
    </div>
  );
}

/** How loud a copy was here, coloured by the same words as a route's legs. */
function Snr({ snr }: { snr: number | null }) {
  if (snr === null) return <span className="heard-snr none">—</span>;
  return (
    <span className={`heard-snr ${quality(snr)}`}>
      {snr > 0 ? "+" : ""}
      {snr.toFixed(1)} <small>dB</small>
    </span>
  );
}

/**
 * Ours on a channel, as the copies heard back tell it: the repeaters that
 * heard it from us, each with how loud its copy was here, and in one line how
 * many carried it further and how far; that line opens the chains.
 */
function Spread({ echoes, relay }: { echoes: MessageEcho[]; relay: (hash: string) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const spread = spreadOf(echoes);
  const n = spread.first.length;
  const more = spread.further.length;
  return (
    <>
      <span className="heard-head">
        Heard you <span className="muted">· {n} repeater{n === 1 ? "" : "s"}</span>
      </span>
      <div className="heard-rows">
        {spread.first.map((f) => (
          <div className="heard-row" key={f.hash}>
            <span className="heard-name">{relay(f.hash)}</span>
            <Snr snr={f.snr} />
          </div>
        ))}
      </div>
      {more > 0 ? (
        <>
          <button type="button" className="heard-more" aria-expanded={open} onClick={() => setOpen(!open)}>
            Went on through {more} more
            <span className="muted">
              {" "}
              · {spread.farthest} hops out {open ? "▴" : "›"}
            </span>
          </button>
          {open
            ? spread.chains.map((c, i) => (
                <span className="heard-chain" key={i}>
                  {c.map((hash, j) => (
                    <Fragment key={j}>
                      {j > 0 ? <span className="sep"> › </span> : null}
                      {relay(hash)}
                    </Fragment>
                  ))}
                </span>
              ))
            : null}
        </>
      ) : null}
    </>
  );
}

/** Someone else's message: the way the copy it was read from came, in one line, and the other copies behind a tap. */
function Arrived({ echoes, relay }: { echoes: MessageEcho[]; relay: (hash: string) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const path = (echo: MessageEcho) =>
    echo.path.length === 0 ? (
      <span className="muted">heard direct</span>
    ) : (
      echo.path.map((hash, j) => (
        <Fragment key={j}>
          {j > 0 ? <span className="sep"> › </span> : null}
          {relay(hash)}
        </Fragment>
      ))
    );
  const [first, ...rest] = echoes;
  return (
    <>
      <div className="heard-row">
        <span className="heard-name wrap">
          <span className="muted">{first!.path.length ? "Came via " : ""}</span>
          {path(first!)}
        </span>
        <Snr snr={first!.snr} />
      </div>
      {rest.length > 0 ? (
        <>
          <button type="button" className="heard-more" aria-expanded={open} onClick={() => setOpen(!open)}>
            {rest.length} more cop{rest.length === 1 ? "y" : "ies"} <span className="muted">{open ? "▴" : "›"}</span>
          </button>
          {open ? (
            <div className="heard-rows">
              {rest.map((echo, i) => (
                <div className="heard-row" key={i}>
                  <span className="heard-name wrap">{path(echo)}</span>
                  <Snr snr={echo.snr} />
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/** A relay by name: its contact opens on a tap, and a hash several contacts share lists them. */
function Relay({ hash, contacts, pick, onPick }: { hash: string; contacts: Record<string, ContactRecord>; pick: string | null; onPick: (hash: string | null) => void }) {
  const matches = candidatesOfHash(hash, contacts);
  if (matches.length === 1) {
    return (
      <button type="button" className="relay" onClick={() => openProfile(matches[0]!.key)}>
        {matches[0]!.name || matches[0]!.prefix}
      </button>
    );
  }
  if (matches.length > 1) {
    return (
      <button type="button" className={["relay amb", pick === hash ? "on" : ""].join(" ")} title={`${matches.length} contacts share this hash`} onClick={() => onPick(pick === hash ? null : hash)}>
        <span className="hop-hash">{hash}</span>?
      </button>
    );
  }
  return (
    <span className="relay unknown" title="No contact has this hash">
      <span className="hop-hash">{hash}</span>
    </span>
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
