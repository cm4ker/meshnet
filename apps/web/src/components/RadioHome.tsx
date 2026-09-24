import { useRef, useSyncExternalStore } from "react";
import { battery, batteryPercent, plural } from "../lib/format.js";
import { disconnect } from "../lib/link.js";
import { useLookalikePrefs } from "../lib/lookalikes.js";
import { openRadioPage, type RadioPage } from "../lib/nav.js";
import { canHover } from "../lib/platform.js";
import { PULL_TRIGGER, usePull } from "../lib/pull.js";
import { resync, STEP_COUNT, STEP_LABELS, useResync } from "../lib/resync.js";
import { summaryOf, useNoticePrefs } from "../lib/noticePrefs.js";
import { session, useSelector, useSession } from "../lib/session.js";
import { act } from "../lib/toast.js";
import { useDesktopUpdateInfo } from "../lib/updates.js";
import { memoryUse } from "../lib/tidy.js";
import { getPreference, listThemes, subscribeTheme } from "../theme/store.js";
import { Button, IconButton } from "../ui/Button.js";
import { Group, LinkRow } from "../ui/List.js";
import { showMenu } from "../ui/Menu.js";
import { Avatar } from "./Avatar.js";
import { AirIcon, BellIcon, InfoIcon, LinkIcon, LocationIcon, LogIcon, PaletteIcon, PowerIcon, RadioIcon, RefreshIcon, ShieldIcon, SlidersIcon, TextIcon, UsersIcon, WavesIcon } from "./Icons.js";
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
  const events = useSelector((state) => state.log.length);
  const lookalikes = useLookalikePrefs();
  const theme = useSyncExternalStore(subscribeTheme, getPreference);
  const self = state.self;
  const online = state.status === "ready";
  const row = (page: RadioPage, icon: React.ReactNode, value?: string) => (
    <LinkRow key={page} icon={icon} label={RADIO_TITLES[page]} value={value} tone={page === "power" ? "danger" : undefined} selected={selected === page} onClick={() => openRadioPage(page)} />
  );
  const notices = summaryOf(useNoticePrefs());
  const use = memoryUse(state);
  const contactsValue = state.contactsFull ? "Full" : use ? `${use.used} of ${use.max}` : undefined;
  const reading = useResync();
  const scroller = useRef<HTMLDivElement>(null);
  const pull = usePull(scroller, onPull, online && !reading);

  return (
    <div className="list-pane radio-home">
      <header className="list-head">
        <h1>Radio</h1>
        {/* A phone pulls the list down instead. */}
        {canHover() ? (
          <IconButton label="Read everything from the radio again" disabled={!online || !!reading} onClick={onPull}>
            <RefreshIcon size={17} className={reading ? "spin" : ""} />
          </IconButton>
        ) : null}
      </header>
      {reading ? (
        <div className="resync-bar" role="progressbar" aria-valuemin={0} aria-valuemax={STEP_COUNT} aria-valuenow={reading.index}>
          <i style={{ width: `${((reading.index + 0.5) / STEP_COUNT) * 100}%` }} />
        </div>
      ) : null}
      <div className="screen-scroll" ref={scroller}>
        {pull > 0 ? (
          <div className="pull-hint" style={{ height: pull }}>
            <RefreshIcon size={17} style={{ transform: `rotate(${(pull / PULL_TRIGGER) * 270}deg)` }} />
            <span>{pull >= PULL_TRIGGER ? "Release to read from the radio" : "Pull to read from the radio"}</span>
          </div>
        ) : null}
        <div className="radio-card">
          <div className="radio-card-head">
            {/* A glyph, not initials: "Node-21" would read "NO". */}
            <Avatar name={self?.name ?? "Radio"} size={44} icon={<RadioIcon size={22} />} />
            <span className="row-main">
              <span className="row-title">{self?.name ?? "Radio"}</span>
              <span className={["row-sub", online ? "muted" : "danger"].join(" ")}>
                {!online ? "Offline · reconnecting" : reading ? `${STEP_LABELS[reading.step]} · ${reading.index + 1} of ${STEP_COUNT}` : state.link ? state.link.label : "online"}
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
          {row("frequency", <RadioIcon size={17} />, self ? `${presetName(self)} · ${self.txPower} dBm` : undefined)}
          {row("contacts", <UsersIcon size={17} />, contactsValue)}
          {row("privacy", <ShieldIcon size={17} />)}
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
          {row("log", <LogIcon size={17} />, plural(events, "event"))}
          {row("power", <PowerIcon size={17} />)}
          {row("about", <InfoIcon size={17} />, appInfo.version)}
        </Group>
      </div>
    </div>
  );
}

function onPull(): void {
  void resync();
}
