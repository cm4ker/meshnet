import { useState, useSyncExternalStore } from "react";
import { setLookalikePrefs, useLookalikePrefs } from "../lib/lookalikes.js";
import { askPermission, notificationsWanted, setNotificationsWanted } from "../lib/notify.js";
import { limitLabel, limitValue, parseLimit, ROUTE_LIMITS } from "../lib/routes.js";
import { session, useSession } from "../lib/session.js";
import { shell } from "../lib/platform.js";
import { autoConnectWanted, setAutoConnect } from "../transports/index.js";
import { Field, Row, Section, Select, Toggle } from "../ui/Field.js";
import { getPreference, listThemes, setPreference, subscribeTheme } from "../theme/store.js";

export function SettingsView() {
  const preference = useSyncExternalStore(subscribeTheme, getPreference);
  const [notifyOn, setNotifyOn] = useState(notificationsWanted);
  const [auto, setAuto] = useState(autoConnectWanted);
  const lookalikes = useLookalikePrefs();
  const state = useSession();
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
      <Section title="Messages">
        <Toggle
          label="Swap lookalike letters"
          hint="а е о р с х and А В Е К М Н О Р С Т Х go out as their Latin twins: they look the same and take one byte instead of two, so about a fifth more text fits."
          checked={lookalikes.on}
          onChange={(v) => setLookalikePrefs({ on: v })}
        />
        {lookalikes.on ? (
          <Toggle label="Also у and У" hint="The same as y and Y in most fonts, not in every one." checked={lookalikes.near} onChange={(v) => setLookalikePrefs({ near: v })} />
        ) : null}
        <Field
          label="Drop direct-message routes after"
          hint={
            state.self
              ? "Chats and rooms. A route the radio learned this long ago is dropped, and the next message floods to find a fresh one. A contact can set its own."
              : "Kept per radio: connect to change it."
          }
        >
          <Select
            value={limitValue(state.routing.resetAfterMin)}
            disabled={!state.self}
            onChange={(e) => session.setDefaultRouteReset(parseLimit(e.target.value) ?? null)}
          >
            {ROUTE_LIMITS.map((m) => (
              <option key={limitValue(m)} value={limitValue(m)}>
                {limitLabel(m)}
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
