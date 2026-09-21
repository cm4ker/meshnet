import { useState } from "react";
import { AdvType, aclRoleName, contactConversation, isConversationType, isFavourite, isNodeType, NoReplyError } from "@meshnet/meshcore";
import { ago, agoPhrase } from "../lib/format.js";
import { bearingDeg, compass, distanceKm, formatDistance, hasPosition } from "../lib/geo.js";
import { openConversation, openNodePage, openRoute, showOnMap, type NodePage } from "../lib/nav.js";
import { isAdmin, kindLabel } from "../lib/nodes.js";
import { routeWords } from "../lib/routes.js";
import { forgetPassword, hasSavedPassword, useSavedPasswords } from "../lib/secrets.js";
import { session, useSession } from "../lib/session.js";
import { act, toast } from "../lib/toast.js";
import { IconButton } from "../ui/Button.js";
import { Confirm, Prompt } from "../ui/Dialog.js";
import { ActionRow, Group, InfoRow, LinkRow } from "../ui/List.js";
import { showMenu, type MenuItem } from "../ui/Menu.js";
import { Avatar } from "./Avatar.js";
import { AirIcon, ChartIcon, ChatIcon, CheckIcon, CopyIcon, EditIcon, LockIcon, MapIcon, MoreIcon, PowerIcon, ShieldIcon, SlidersIcon, StarFilledIcon, StarIcon, TerminalIcon, TrashIcon, UsersIcon, CloseIcon } from "./Icons.js";
import { NodeStatus } from "./node/Status.js";
import { QueuePill } from "./node/QueuePill.js";
import { SignIn } from "./node/SignIn.js";
import { Readings } from "./Readings.js";
import { Gone, ScreenHead, type Chrome } from "./ScreenHead.js";

const PAGES: Record<NodePage, { label: string; icon: React.ReactNode; admin: boolean }> = {
  neighbours: { label: "Neighbours", icon: <UsersIcon size={17} />, admin: false },
  history: { label: "History", icon: <ChartIcon size={17} />, admin: false },
  settings: { label: "Settings", icon: <SlidersIcon size={17} />, admin: true },
  access: { label: "Access", icon: <ShieldIcon size={17} />, admin: true },
  console: { label: "Console", icon: <TerminalIcon size={17} />, admin: true },
};

export function nodePages(type: number): NodePage[] {
  if (type === AdvType.Repeater) return ["neighbours", "settings", "access", "console"];
  if (type === AdvType.Room) return ["settings", "access", "console"];
  return ["history", "settings", "access", "console"];
}

/**
 * One node, whoever it is: a person, a repeater, a room, a sensor. What is
 * done most sits in the buttons at the top; what is done rarely is in More.
 * A repeater, room or sensor you have signed in to also shows how it is
 * doing, and opens its own screens.
 */
export function Profile({ contactKey, chrome }: { contactKey: string; chrome: Chrome }) {
  const state = useSession();
  const saved = useSavedPasswords();
  const contact = state.contacts[contactKey];
  const [ask, setAsk] = useState<"rename" | "remove" | "forget" | "reboot" | "signin" | null>(null);
  const online = state.status === "ready";

  if (!contact) return <Gone chrome={chrome} title="Contact" text="This contact is no longer on the radio." />;

  const key = contact.key;
  const name = contact.name || contact.prefix;
  const node = isNodeType(contact.type);
  const routed = isConversationType(contact.type);
  const login = state.logins[key];
  const signedIn = !!login?.ok;
  const admin = isAdmin(login);
  const managed = login !== undefined || state.statusHistory[key] !== undefined || saved.includes(key);
  const self = state.self;
  const placed = hasPosition(contact.lat, contact.lon);
  const where = self && placed && hasPosition(self.lat, self.lon) ? `${formatDistance(distanceKm(self.lat, self.lon, contact.lat, contact.lon))} ${compass(bearingDeg(self.lat, self.lon, contact.lat, contact.lon))} of you` : placed ? "" : "No position shared";
  const heard = Math.max(contact.lastHeardAt ?? 0, contact.lastAdvert * 1000) || null;
  const route = routeWords(contact);
  const telemetry = state.telemetry[key];
  const owner = state.ownerInfo[key];

  const cli = (command: string, done: string) => () =>
    void act(async () => {
      try {
        await session.runCli(key, command);
      } catch (e) {
        // A reboot sends no reply.
        if (!(command === "reboot" && e instanceof NoReplyError)) throw e;
      }
    }, done);

  const more = () => {
    const items: MenuItem[] = [
      { label: "Rename", icon: <EditIcon size={17} />, onSelect: () => setAsk("rename"), disabled: !online },
      { label: "Share on the air", icon: <AirIcon size={17} />, air: true, disabled: !online, onSelect: () => void act(() => session.shareContact(key), `${name} shared on the air`) },
      { label: "Copy the public key", icon: <CopyIcon size={17} />, onSelect: () => void navigator.clipboard?.writeText(key).then(() => toast("Copied")) },
    ];
    if (admin) {
      items.push(
        { label: "Advertise across the mesh", icon: <AirIcon size={17} />, air: true, disabled: !online, onSelect: cli("advert", `${name} advertised`) },
        { label: "Advertise to its neighbours", icon: <AirIcon size={17} />, air: true, disabled: !online, onSelect: cli("advert.zerohop", `${name} advertised nearby`) },
      );
      if (contact.type !== AdvType.Sensor) items.push({ label: "Clear its statistics", icon: <AirIcon size={17} />, air: true, disabled: !online, onSelect: cli("clear stats", "Statistics cleared") });
      if (contact.type === AdvType.Repeater) items.push({ label: owner ? "Ask for firmware and owner again" : "Ask for firmware and owner", icon: <AirIcon size={17} />, air: true, disabled: !online, onSelect: () => void act(() => session.requestOwnerInfo(key)) });
      items.push({ label: `Reboot ${name}`, icon: <PowerIcon size={17} />, danger: true, disabled: !online, onSelect: () => setAsk("reboot") });
    }
    if (node && managed) items.push({ label: "Forget this node", icon: <CloseIcon size={17} />, danger: true, onSelect: () => setAsk("forget") });
    items.push({ label: "Remove the contact", icon: <TrashIcon size={17} />, danger: true, disabled: !online, onSelect: () => setAsk("remove") });
    showMenu(items, { title: name });
  };

  const signedMenu = () =>
    showMenu(
      [
        { label: admin ? "Sign in again" : "Sign in as admin", icon: <LockIcon size={17} />, air: true, disabled: !online, onSelect: () => setAsk("signin") },
        { label: "Sign out", icon: <CloseIcon size={17} />, air: true, disabled: !online, onSelect: () => void act(() => session.logout(key), "Signed out") },
      ],
      { title: `${name} · ${login?.role === null || login?.role === undefined ? "signed in" : `signed in as ${aclRoleName(login.role)}`}` },
    );

  return (
    <div className="screen">
      <ScreenHead
        chrome={chrome}
        actions={
          <>
            {node ? <QueuePill nodeKey={key} /> : null}
            <IconButton label={isFavourite(contact) ? "Remove from favourites" : "Add to favourites"} disabled={!online} onClick={() => void act(() => session.setFavourite(key, !isFavourite(contact)))}>
              {isFavourite(contact) ? <StarFilledIcon size={19} className="star" /> : <StarIcon size={19} />}
            </IconButton>
          </>
        }
      />
      <div className="screen-scroll">
        <div className="hero">
          <Avatar name={name} type={contact.type} size={68} />
          <h1>{name}</h1>
          <span className="muted">
            {kindLabel(contact.type)} · heard {agoPhrase(heard)}
          </span>
          {where ? <span className="muted">{where}</span> : null}
        </div>

        <div className="hero-actions">
          {routed ? (
            <button type="button" className="hero-act primary" onClick={() => openConversation(contactConversation(key))}>
              <ChatIcon size={20} />
              Message
            </button>
          ) : null}
          {node ? (
            signedIn ? (
              <button type="button" className="hero-act" onClick={signedMenu}>
                <CheckIcon size={20} />
                {admin ? "Admin" : "Signed in"}
              </button>
            ) : (
              <button type="button" className={["hero-act", routed ? "" : "primary"].join(" ")} disabled={!online} onClick={() => setAsk("signin")}>
                <LockIcon size={20} />
                Sign in
              </button>
            )
          ) : null}
          <button type="button" className="hero-act" disabled={!placed} onClick={() => showOnMap(key)}>
            <MapIcon size={20} />
            On map
          </button>
          <button type="button" className="hero-act" onClick={more}>
            <MoreIcon size={20} />
            More
          </button>
        </div>

        <Group>
          <LinkRow label="Route" value={<span className={`route-${route.tone}`}>{route.text}</span>} onClick={() => openRoute(key)} />
        </Group>

        {node && (managed || signedIn) ? <NodeStatus contact={contact} /> : null}

        {node ? (
          <Group title="Manage" note={signedIn ? (admin ? undefined : "Settings, access and the console need the admin password.") : "Sign in to see what it hears. Settings, access and the console need the admin password."}>
            {nodePages(contact.type).map((page) => {
              const locked = !signedIn || (PAGES[page].admin && !admin);
              return (
                <LinkRow
                  key={page}
                  icon={PAGES[page].icon}
                  label={PAGES[page].label}
                  disabled={locked}
                  trailing={locked ? <LockIcon size={14} className="line-chev" /> : undefined}
                  onClick={() => openNodePage(key, page)}
                />
              );
            })}
          </Group>
        ) : (
          <Group title={telemetry ? `Readings · ${ago(telemetry.at)}` : "Readings"} note={telemetry ? undefined : "Its radio answers only if its owner lets this one read it."}>
            {telemetry ? <Readings readings={telemetry.readings} /> : null}
            <ActionRow label="Request telemetry" air disabled={!online} onClick={() => void act(() => session.requestTelemetry(key))} />
          </Group>
        )}

        <Group title="Details">
          <LinkRow label="Public key" value={<span className="mono">{key.slice(0, 16)}…</span>} trailing={<CopyIcon size={14} className="line-chev" />} onClick={() => void navigator.clipboard?.writeText(key).then(() => toast("Copied"))} />
          {placed ? (
            <InfoRow label="Position" mono>
              {contact.lat.toFixed(5)}, {contact.lon.toFixed(5)}
            </InfoRow>
          ) : null}
          {owner ? (
            <>
              <InfoRow label="Firmware" mono>
                {owner.firmware}
              </InfoRow>
              <InfoRow label="Owner">{owner.owner ? <span className="multiline">{owner.owner}</span> : "not set"}</InfoRow>
            </>
          ) : null}
          {login?.firmwareLevel != null ? <InfoRow label="Firmware level">{login.firmwareLevel}</InfoRow> : null}
        </Group>
      </div>

      <SignIn open={ask === "signin"} nodeKey={key} onClose={() => setAsk(null)} onSignedIn={() => { setAsk(null); toast(`Signed in to ${name}`); }} />
      <Prompt
        open={ask === "rename"}
        title="Rename"
        label="Name on your radio; the node keeps its own"
        initial={contact.name}
        submitLabel="Save"
        onCancel={() => setAsk(null)}
        onSubmit={async (value) => {
          if (value.trim()) await act(() => session.renameContact(key, value.trim()));
          setAsk(null);
        }}
      />
      <Confirm
        open={ask === "remove"}
        title={`Remove ${name}?`}
        body={<p>The radio forgets it; it comes back on its next advert while new contacts are added automatically. Its messages stay here.</p>}
        confirmLabel="Remove"
        danger
        onCancel={() => setAsk(null)}
        onConfirm={async () => {
          setAsk(null);
          if (await act(() => session.removeContact(key), "Removed")) (chrome.onClose ?? chrome.onBack)?.();
        }}
      />
      <Confirm
        open={ask === "forget"}
        title={`Forget ${name}?`}
        body={
          <p>
            It leaves your nodes, {hasSavedPassword(key) ? "its saved password is deleted, " : ""}and its status history goes. The contact stays, and the node keeps its own record of
            this radio, so a later sign-in may need no password.
          </p>
        }
        confirmLabel="Forget"
        danger
        onCancel={() => setAsk(null)}
        onConfirm={async () => {
          setAsk(null);
          await forgetPassword(key).catch(() => undefined);
          await session.logout(key).catch(() => undefined);
          session.forgetNode(key);
          toast("Forgotten");
        }}
      />
      <Confirm
        open={ask === "reboot"}
        title={`Reboot ${name}?`}
        body={<p>The node goes off the air for a few seconds and forgets its neighbours. It sends no reply.</p>}
        confirmLabel="Reboot"
        danger
        onCancel={() => setAsk(null)}
        onConfirm={() => {
          setAsk(null);
          cli("reboot", `${name} was told to reboot`)();
        }}
      />
    </div>
  );
}
