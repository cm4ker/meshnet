import { useEffect, useMemo, useRef, useState } from "react";
import { CONNECT_TRIES, connectWith, useLink } from "../lib/link.js";
import { shell } from "../lib/platform.js";
import { addressDevice, autoConnectWanted, connectors, lastLink, needsPairing, setAutoConnect, type Connector, type FoundDevice } from "../transports/index.js";
import { Button } from "../ui/Button.js";
import { Prompt } from "../ui/Dialog.js";
import { Input, Toggle } from "../ui/Field.js";
import { LinkIcon } from "./Icons.js";
import { UpdateButton } from "./Updates.js";
import { PrivacyButton } from "./Privacy.js";
import { t } from "../i18n/index.js";
import { errorText } from "../i18n/errors.js";

export function ConnectView() {
  const list = useMemo(connectors, []);
  const last = useMemo(lastLink, []);
  const [active, setActive] = useState<Connector | null>(
    () => list.find((c) => c.id === last?.connectorId) ?? list[0] ?? null,
  );
  const link = useLink();
  const [auto, setAuto] = useState(autoConnectWanted);

  return (
    <div className="connect">
      <div className="connect-card">
        <header className="connect-head">
          <img src="./icon.svg" alt="" width={40} height={40} />
          <div>
            <h1>{shell() === "capacitor" ? "Ommesh" : "Meshnet"}</h1>
            <p className="muted">{t("connect.tagline")}</p>
          </div>
        </header>

        {list.length === 0 ? (
          <NoLink />
        ) : (
          <>
            {list.length > 1 ? (
              <div className="segmented" role="tablist">
                {list.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    role="tab"
                    aria-selected={active?.id === c.id}
                    className={active?.id === c.id ? "on" : ""}
                    onClick={() => setActive(c)}
                  >
                    <LinkIcon kind={c.kind} />
                    {c.title}
                  </button>
                ))}
              </div>
            ) : null}
            {active ? <ConnectorPanel key={active.id} connector={active} lastDevice={last?.connectorId === active.id ? last.device : null} /> : null}
          </>
        )}

        {link.phase === "connecting" ? (
          <p className="connect-status">
            <span className="spinner" />{" "}
            {link.retrying
              ? t("connect.status.reconnectingAttempt", { attempt: link.attempt })
              : link.attempt > 1
                ? t("connect.status.connectingAttempt", { attempt: link.attempt, tries: CONNECT_TRIES })
                : t("connect.status.connecting")}
          </p>
        ) : null}
        {link.error && link.phase === "failed" ? <p className="connect-error">{link.error}</p> : null}

        <Toggle
          label={t("connect.autoConnect")}
          checked={auto}
          onChange={(v) => {
            setAuto(v);
            setAutoConnect(v);
          }}
        />
        <UpdateButton />
        <PrivacyButton />
      </div>
    </div>
  );
}

/** A radio on the network: `host` or `host:port`, the firmware's port when none is given. */
function AddressForm({ busy, onConnect }: { busy: boolean; onConnect: (device: FoundDevice) => void }) {
  const [text, setText] = useState("");
  const device = addressDevice(text);
  return (
    <form
      className="address-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (device) onConnect(device);
      }}
    >
      <Input
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={t("connect.address.placeholder")}
        aria-label={t("connect.address.label")}
        inputMode="url"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="go"
      />
      <Button type="submit" variant="primary" busy={busy} disabled={!device}>
        {t("connect.address.connect")}
      </Button>
    </form>
  );
}

/** Four bars for how well the radio is heard; the figure itself is in the tooltip. */
function SignalBars({ rssi }: { rssi: number }) {
  const lit = rssi >= -60 ? 4 : rssi >= -75 ? 3 : rssi >= -90 ? 2 : 1;
  return (
    <span className="signal-bars" title={t("connect.signal.dbm", { value: rssi })} aria-label={t("connect.signal.bars", { level: lit })}>
      {[1, 2, 3, 4].map((n) => (
        <i key={n} className={n <= lit ? "on" : ""} style={{ height: `${n * 25}%` }} />
      ))}
    </span>
  );
}

function NoLink() {
  const where = shell();
  return (
    <div className="stack">
      <p>{t("connect.noLink.title")}</p>
      <p className="muted">
        {where === "browser" ? t("connect.noLink.browser") : t("connect.noLink.shell")}
      </p>
    </div>
  );
}

function ConnectorPanel({ connector, lastDevice }: { connector: Connector; lastDevice: FoundDevice | null }) {
  const link = useLink();
  const [found, setFound] = useState<FoundDevice[]>([]);
  const [remembered, setRemembered] = useState<FoundDevice[]>([]);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanRun, setScanRun] = useState(0);
  const busy = link.phase === "connecting";

  useEffect(() => {
    let alive = true;
    void connector.remembered().then((d) => alive && setRemembered(d));
    return () => {
      alive = false;
    };
  }, [connector]);

  const scanAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    if (connector.mode !== "scan" || !connector.scan) return;
    const abort = new AbortController();
    scanAbort.current = abort;
    setScanning(true);
    setScanError(null);
    connector
      .scan((devices) => setFound(devices), abort.signal)
      .catch((error: unknown) => setScanError(errorText(error)))
      .finally(() => setScanning(false));
    return () => abort.abort();
  }, [connector, scanRun]);

  const [pinFor, setPinFor] = useState<FoundDevice | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);

  const connect = (device: FoundDevice | null) => {
    // The scan stops first: a radio being connected to is not one to keep listening for.
    scanAbort.current?.abort();
    setScanning(false);
    void connectWith(connector, device).catch((error: unknown) => {
      // A radio that wants a bond: ask for the PIN on its screen, pair, and try again.
      if (device && connector.pair && needsPairing(error)) setPinFor(device);
    });
  };

  const pairAndConnect = async (pin: string) => {
    const device = pinFor;
    if (!device || !connector.pair) return;
    setPinError(null);
    try {
      await connector.pair(device, pin);
    } catch (error) {
      setPinError(errorText(error));
      return;
    }
    setPinFor(null);
    void connectWith(connector, device).catch(() => undefined);
  };

  const shown = new Map<string, FoundDevice>();
  if (lastDevice && lastDevice.id) shown.set(lastDevice.id, lastDevice);
  for (const d of remembered) shown.set(d.id, d);
  for (const d of found) shown.set(d.id, { ...(shown.get(d.id) ?? d), ...d });
  const devices = [...shown.values()];

  return (
    <div className="stack">
      <p className="muted">{connector.description}</p>

      {devices.length > 0 ? (
        <ul className="device-list">
          {devices.map((d) => (
            <li key={d.id}>
              <button type="button" className="device" disabled={busy} onClick={() => connect(d)}>
                <span className="device-text">
                  <span className="device-name">{d.name}</span>
                  <span className="device-detail">{d.id === lastDevice?.id ? t("connect.device.lastUsed") : d.detail}</span>
                </span>
                {d.rssi !== null ? <SignalBars rssi={d.rssi} /> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : connector.mode === "scan" ? (
        <p className="muted">{scanning ? t("connect.scan.looking") : t("connect.scan.none")}</p>
      ) : null}

      {scanError ? <p className="connect-error">{scanError}</p> : null}

      <Prompt
        open={pinFor !== null}
        title={pinFor ? t("connect.pair.titleWith", { name: pinFor.name }) : t("connect.pair.titleRadio")}
        label={t("connect.pair.label")}
        placeholder={t("connect.pair.placeholder")}
        submitLabel={t("connect.pair.submit")}
        onCancel={() => {
          setPinFor(null);
          setPinError(null);
        }}
        onSubmit={pairAndConnect}
      />
      {pinError && pinFor ? <p className="connect-error">{pinError}</p> : null}

      <div className="row-actions">
        {connector.mode === "address" ? (
          <AddressForm busy={busy} onConnect={connect} />
        ) : connector.mode === "picker" ? (
          <Button variant="primary" busy={busy} onClick={() => connect(null)}>
            {connector.kind === "ble" ? t("connect.choose.radio") : t("connect.choose.port")}
          </Button>
        ) : (
          <Button busy={scanning} onClick={() => setScanRun((n) => n + 1)}>
            {scanning ? t("connect.scan.scanning") : t("connect.scan.again")}
          </Button>
        )}
      </div>
    </div>
  );
}
