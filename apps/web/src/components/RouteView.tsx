import { AdvType, contactRoute, isConversationType } from "@meshnet/meshcore";
import { discover as discoverPath, useDiscovery } from "../lib/discovery.js";
import { nameOfHash } from "../lib/echoes.js";
import { agoPhrase, timeOfDay } from "../lib/format.js";
import { inMinutes, limitLabel, limitValue, parseLimit, ROUTE_LIMITS, routeWords, useNow } from "../lib/routes.js";
import { session, useSession } from "../lib/session.js";
import { act, toast } from "../lib/toast.js";
import { changeRoute } from "../lib/toolActions.js";
import { ActionRow, Block, Group, SelectRow, SwitchRow } from "../ui/List.js";
import { Gone, ScreenHead, type Chrome } from "./ScreenHead.js";

/**
 * How messages reach a contact, in words: through whom, since when, until
 * when; and what to do about it. Everything about flooding lives here.
 */
export function RouteView({ contactKey, chrome }: { contactKey: string; chrome: Chrome }) {
  const state = useSession();
  const now = useNow();
  const discovering = useDiscovery(contactKey)?.running ?? false;
  const contact = state.contacts[contactKey];
  if (!contact) return <Gone chrome={chrome} title="Route" text="This contact is no longer on the radio." />;
  const key = contact.key;
  const name = contact.name || contact.prefix;
  const online = state.status === "ready";
  const governed = isConversationType(contact.type);
  const policy = session.routePolicy(key);
  const route = contactRoute(contact);
  const expires = session.routeExpiresAt(key);
  const words = routeWords(contact);
  const own = state.routing.contacts[key]?.resetAfterMin;
  // A repeater or a room answers a discovery only from a radio signed in to it.
  const needsSignIn = (contact.type === AdvType.Repeater || contact.type === AdvType.Room) && !state.logins[key]?.ok;

  // The map draws what it found too, when the node is on it.
  const discover = async () => {
    const d = await discoverPath(key);
    if (d.found) {
      const via = d.found.out.length === 0 ? "heard direct" : `via ${d.found.out.map((h) => nameOfHash(h, state.contacts) ?? h).join(" › ")}`;
      toast(governed && policy.flood ? `Found ${via}; it still floods` : d.found.changed ? `Found ${via}: now the route` : `Found ${via}, the route it had`);
    } else {
      toast(d.silent ? (needsSignIn ? `No answer. ${name} answers only a radio signed in to it.` : `No answer from ${name}: out of range for now.`) : (d.error ?? "Discovery failed"), "error");
    }
  };

  const line = governed && policy.flood
    ? "Every message floods; each route the radio learns is dropped."
    : route === null
      ? "No route known. The next message floods, and its acknowledgement brings a route back."
      : route.length === 0
        ? "A neighbour, heard direct: no relays."
        : [contact.pathSince ? `Learned ${agoPhrase(contact.pathSince)}` : "", expires !== null ? `forgotten ${inMinutes(expires - now)}` : "kept until the radio learns another"].filter(Boolean).join(" · ");

  return (
    <div className="screen">
      <ScreenHead chrome={chrome}>
        <span className="screen-name">Route to {name}</span>
      </ScreenHead>
      <div className="screen-scroll">
        <div className="hero compact">
          <h1>{words.text[0]!.toUpperCase() + words.text.slice(1)}</h1>
          <span className="muted">{line}</span>
          {contact.pathSince && expires !== null ? <span className="muted small">at {timeOfDay(expires / 1000)}</span> : null}
        </div>

        {route && route.length > 0 && !(governed && policy.flood) ? (
          <Group title="Relays">
            <Block>
              <span className="hops">
                <span className="hop end">You</span>
                {route.map((hash, i) => (
                  <span key={i} className="hops-step">
                    <span className="sep">›</span>
                    <span className={["hop", nameOfHash(hash, state.contacts) ? "" : "amb"].join(" ")}>
                      {nameOfHash(hash, state.contacts) ?? "?"} <span className="hop-hash">{hash}</span>
                    </span>
                  </span>
                ))}
                <span className="sep">›</span>
                <span className="hop end">{name}</span>
              </span>
            </Block>
          </Group>
        ) : null}

        {governed ? (
          <Group>
            <SwitchRow
              label="Always flood"
              hint="Ignore learned routes. Handy on the move; costs the mesh a flood per message."
              checked={policy.flood}
              disabled={!online}
              onChange={(v) => void act(() => session.setFloodPinned(key, v), v ? "Every message to it floods" : "Learned routes again")}
            />
            <SelectRow
              label="Forget the learned route after"
              value={limitValue(own)}
              disabled={policy.flood}
              options={[{ value: "default", label: `Default (${limitLabel(state.routing.resetAfterMin).toLowerCase()})` }, ...ROUTE_LIMITS.map((m) => ({ value: limitValue(m), label: limitLabel(m) }))]}
              onChange={(v) => session.setRouteReset(key, parseLimit(v))}
            />
          </Group>
        ) : null}

        <Group note={`Discovery floods a request, and the way it reached ${name} becomes the route.${needsSignIn ? ` ${name} answers it only once you are signed in.` : ""}`}>
          <ActionRow label="Forget the route now" disabled={!online || !route || (governed && policy.flood)} onClick={() => void act(() => session.resetPath(key), "Route forgotten: the next message floods")} />
          <ActionRow label="Discover the path" hint={discovering ? "Waiting for the answer…" : undefined} air busy={discovering} disabled={!online} onClick={() => void discover()} />
          <ActionRow label="Change on the map" hint="Tap the repeaters it should go through, in order." disabled={!online} onClick={() => changeRoute(key)} />
        </Group>
      </div>
    </div>
  );
}
