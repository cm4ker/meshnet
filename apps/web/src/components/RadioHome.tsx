import { useSyncExternalStore } from "react";
import { battery, batteryPercent, bandwidth, frequency, plural } from "../lib/format.js";
import { disconnect } from "../lib/link.js";
import { useLookalikePrefs } from "../lib/lookalikes.js";
import { openRadioPage, type RadioPage } from "../lib/nav.js";
import { nodeNotificationsWanted, notificationsWanted } from "../lib/notify.js";
import { session, useSession } from "../lib/session.js";
import { act } from "../lib/toast.js";
import { useDesktopUpdateInfo } from "../lib/updates.js";
import { getPreference, listThemes, subscribeTheme } from "../theme/store.js";
import { Button } from "../ui/Button.js";
import { Group, LinkRow } from "../ui/List.js";
import { showMenu } from "../ui/Menu.js";
import { Avatar } from "./Avatar.js";
import { AirIcon, BellIcon, InfoIcon, LinkIcon, LocationIcon, LogIcon, PaletteIcon, PowerIcon, RadioIcon, ShieldIcon, SlidersIcon, TextIcon, WavesIcon } from "./Icons.js";
import { presetName, RADIO_TITLES } from "./RadioPages.js";


/** Advertising: once to the neighbours, or flooded across the mesh. */
export function advertise(at: { x: number; y: number } | null = null): void {
  showMenu(
    [
      { label: "Nearby", hint: "Neighbours only, zero hop. Cheap.", icon: <RadioIcon size={18} />, air: true, onSelect: () => void act(() => session.sendAdvert(false), "Advert sent to the neighbours") },
      { label: "Across the mesh", hint: "A flood every repeater passes on. Costs airtime.", icon: <WavesIcon size={18} />, air: true, onSelect: () => void act(() => session.sendAdvert(true), "Advert flooded across the mesh") },
    ],
    { title: "Advertise this radio", at },
  );
}

/**
 * The radio section's root: this radio's state and the two things done most
 * with it, then one row per topic, each with what it is set to now.
 */
export function RadioHome({ selected }: { selected: RadioPage | null }) {
  const appInfo = useDesktopUpdateInfo();
  const state = useSession();
  const lookalikes = useLookalikePrefs();
  const theme = useSyncExternalStore(subscribeTheme, getPreference);
  const self = state.self;
  const online = state.status === "ready";
  const row = (page: RadioPage, icon: React.ReactNode, value?: string) => (
    <LinkRow key={page} icon={icon} label={RADIO_TITLES[page]} value={value} tone={page === "power" ? "danger" : undefined} selected={selected === page} onClick={() => openRadioPage(page)} />
  );
  const notices = notificationsWanted() ? (nodeNotificationsWanted() ? "On" : "Messages") : nodeNotificationsWanted() ? "New nodes" : "Off";

  return (
    <div className="list-pane radio-home">
      <header className="list-head">
        <h1>Radio</h1>
      </header>
      <div className="screen-scroll">
        <div className="radio-card">
          <div className="radio-card-head">
            <Avatar name={self?.name ?? "Radio"} size={44} />
            <span className="row-main">
              <span className="row-title">{self?.name ?? "Radio"}</span>
              <span className={["row-sub", online ? "muted" : "danger"].join(" ")}>
                {online ? (state.link ? state.link.label : "online") : "Offline · reconnecting"}
              </span>
            </span>
            <button type="button" className="radio-battery" disabled={!online} title="Read the battery again" onClick={() => void act(() => session.refreshBattery())}>
              {state.battery ? (
                <>
                  <b>{batteryPercent(state.battery.mv)}%</b>
                  <small>{battery(state.battery.mv)}</small>
                </>
              ) : (
                <b>—</b>
              )}
            </button>
          </div>
          {self ? (
            <div className="radio-card-freq mono">
              {/* A narrow phone breaks the line between values, never inside one. */}
              {[frequency(self.frequencyKhz), bandwidth(self.bandwidthHz), `SF${self.spreadingFactor}`, `CR 4/${self.codingRate}`, `${self.txPower} dBm`].map((part) => part.replaceAll(" ", " ")).join(" · ")}
            </div>
          ) : null}
          <div className="radio-card-actions">
            <Button variant="primary" size="lg" disabled={!online} onClick={(e) => advertise(e.detail === 0 ? null : { x: e.clientX, y: e.clientY })}>
              <AirIcon size={17} />
              Advertise
            </Button>
            <Button size="lg" onClick={() => void disconnect()}>
              Disconnect
            </Button>
          </div>
        </div>

        <Group title="This radio">
          {row("name", <LocationIcon size={17} />, self?.name)}
          {row("frequency", <RadioIcon size={17} />, self ? presetName(self) : undefined)}
          {row("privacy", <ShieldIcon size={17} />, self ? (self.manualAddContacts & 1 ? "Manual add" : "Auto-add") : undefined)}
          {row("advanced", <SlidersIcon size={17} />)}
        </Group>
        <Group title="This app">
          {row("notifications", <BellIcon size={17} />, notices)}
          {row("messages", <TextIcon size={17} />, lookalikes.on ? "Lookalikes" : undefined)}
          {row("appearance", <PaletteIcon size={17} />, theme === "system" ? "System" : listThemes().find((t) => t.id === theme)?.name)}
          {row("connection", state.link ? <LinkIcon kind={state.link.kind} size={17} /> : <RadioIcon size={17} />, state.link ? { ble: "Bluetooth", serial: "USB", tcp: "Wi-Fi" }[state.link.kind] : undefined)}
        </Group>
        <Group>
          {row("air", <WavesIcon size={17} />, "Listen")}
          {row("log", <LogIcon size={17} />, plural(state.log.length, "event"))}
          {row("power", <PowerIcon size={17} />)}
          {row("about", <InfoIcon size={17} />, appInfo.version)}
        </Group>
      </div>
    </div>
  );
}
