import { useState, useSyncExternalStore } from "react";
import { askPermission, notificationsWanted, setNotificationsWanted } from "../lib/notify.js";
import { shell } from "../lib/platform.js";
import { autoConnectWanted, setAutoConnect } from "../transports/index.js";
import { Field, Row, Section, Select, Toggle } from "../ui/Field.js";
import { getPreference, listThemes, setPreference, subscribeTheme } from "../theme/store.js";

export function SettingsView() {
  const preference = useSyncExternalStore(subscribeTheme, getPreference);
  const [notifyOn, setNotifyOn] = useState(notificationsWanted);
  const [auto, setAuto] = useState(autoConnectWanted);
  return (
    <div className="card-scroll">
      <Section title="Appearance">
        <Field label="Theme">
          <Select value={preference} onChange={(e) => setPreference(e.target.value)}>
            <option value="system">Follow the system</option>
            {listThemes().map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
      </Section>
      <Section title="Behaviour">
        <Toggle
          label="Announce messages"
          hint="A system notification for a message that arrives while the window is elsewhere."
          checked={notifyOn}
          onChange={async (v) => {
            if (v && !(await askPermission())) return;
            setNotifyOn(v);
            setNotificationsWanted(v);
          }}
        />
        <Toggle
          label="Reconnect at launch"
          checked={auto}
          onChange={(v) => {
            setAuto(v);
            setAutoConnect(v);
          }}
        />
      </Section>
      <Section title="About">
        <Row label="Meshnet">{__APP_VERSION__}</Row>
        <Row label="Running in">{shell() === "tauri" ? "the desktop shell" : shell() === "capacitor" ? "the phone shell" : "a browser"}</Row>
        <p className="muted small">A companion for MeshCore radios. Messages stay on this device; the radio keeps only what has not been read yet.</p>
      </Section>
    </div>
  );
}
