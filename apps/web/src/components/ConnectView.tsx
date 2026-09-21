import { useEffect, useMemo, useRef, useState } from "react";
import { connectWith, useLink } from "../lib/link.js";
import { shell } from "../lib/platform.js";
import { autoConnectWanted, connectors, lastLink, needsPairing, setAutoConnect, type Connector, type FoundDevice } from "../transports/index.js";
import { Button } from "../ui/Button.js";
import { Prompt } from "../ui/Dialog.js";
import { Toggle } from "../ui/Field.js";
import { BluetoothIcon, UsbIcon } from "./Icons.js";

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
            <h1>Meshnet</h1>
            <p className="muted">A MeshCore companion.</p>
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
                    {c.kind === "ble" ? <BluetoothIcon /> : <UsbIcon />}
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
            <span className="spinner" /> {link.retrying ? `Reconnecting (attempt ${link.attempt})…` : "Connecting…"}
          </p>
        ) : null}
        {link.error && link.phase === "failed" ? <p className="connect-error">{link.error}</p> : null}

        <Toggle
          label="Reconnect at launch"
          checked={auto}
          onChange={(v) => {
            setAuto(v);
            setAutoConnect(v);
          }}
        />
      </div>
    </div>
  );
}

function NoLink() {
  const where = shell();
  return (
    <div className="stack">
      <p>This browser cannot reach a radio: it has neither Web Bluetooth nor Web Serial.</p>
      <p className="muted">
        {where === "browser"
          ? "Chrome or Edge can. Or use the desktop or phone application, which carry their own Bluetooth and USB."
          : "The shell offered no link; this is a bug."}
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
      .catch((error: Error) => setScanError(error.message))
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
      setPinError((error as Error).message);
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
                <span className="device-name">{d.name}</span>
                <span className="device-detail">
                  {d.id === lastDevice?.id ? "last used" : d.detail}
                  {d.rssi !== null ? ` · ${d.rssi} dBm` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : connector.mode === "scan" ? (
        <p className="muted">{scanning ? "Looking for radios…" : "No radios found."}</p>
      ) : null}

      {scanError ? <p className="connect-error">{scanError}</p> : null}

      <Prompt
        open={pinFor !== null}
        title={`Pair with ${pinFor?.name ?? "the radio"}`}
        label="PIN shown on the radio's screen"
        placeholder="6 digits"
        submitLabel="Pair"
        onCancel={() => {
          setPinFor(null);
          setPinError(null);
        }}
        onSubmit={pairAndConnect}
      />
      {pinError && pinFor ? <p className="connect-error">{pinError}</p> : null}

      <div className="row-actions">
        {connector.mode === "picker" ? (
          <Button variant="primary" busy={busy} onClick={() => connect(null)}>
            Choose {connector.kind === "ble" ? "a radio" : "a port"}…
          </Button>
        ) : (
          <Button busy={scanning} onClick={() => setScanRun((n) => n + 1)}>
            {scanning ? "Scanning…" : "Scan again"}
          </Button>
        )}
      </div>
    </div>
  );
}
