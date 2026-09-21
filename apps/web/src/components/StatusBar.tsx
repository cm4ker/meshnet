import { battery, batteryPercent } from "../lib/format.js";
import { useSession } from "../lib/session.js";
import { BluetoothIcon, UsbIcon } from "./Icons.js";

/** The radio's name and link at the top of every list. */
export function StatusBar() {
  const state = useSession();
  const online = state.status === "ready";
  return (
    <header className="statusbar">
      <span className={["dot", online ? "on" : "off"].join(" ")} aria-hidden="true" />
      <span className="statusbar-name">{state.self?.name ?? "Radio"}</span>
      <span className="statusbar-right muted">
        {state.battery ? (
          <span title={battery(state.battery.mv)}>{batteryPercent(state.battery.mv)}%</span>
        ) : null}
        {state.link ? (
          <span title={state.link.label}>{state.link.kind === "ble" ? <BluetoothIcon size={14} /> : <UsbIcon size={14} />}</span>
        ) : null}
      </span>
    </header>
  );
}
