import { useEffect } from "react";
import { isTauri } from "../lib/platform.js";
import { updateBusy } from "../lib/updateController.js";
import { chooseUpdateChannel, closeUpdates, initializeUpdates, installUpdate, openUpdates, setAutomaticChecks, updates, useDesktopUpdateInfo, useUpdates } from "../lib/updates.js";
import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Group, InfoRow, SelectRow, SwitchRow } from "../ui/List.js";
import { RefreshIcon } from "./Icons.js";

export function UpdateButton({ compact = false }: { compact?: boolean }) {
  const state = useUpdates();
  const info = useDesktopUpdateInfo();
  if (!isTauri() || (info.ready && !info.supported && !info.error)) return null;
  const available = state.version !== null;
  return (
    <button type="button" className={compact ? "rail-update" : "update-link"} onClick={openUpdates} title={available ? `Update ${state.version} available` : "App updates"} aria-label={available ? `App updates · ${state.version} available` : "App updates"}>
      <RefreshIcon size={compact ? 18 : 15} />
      <span>{compact ? "Update" : available ? `Update ${state.version} available` : "App updates"}</span>
      {available ? <span className="update-dot" aria-hidden="true" /> : null}
    </button>
  );
}

export function UpdatesDialog() {
  const info = useDesktopUpdateInfo();
  const state = useUpdates();
  useEffect(() => { void initializeUpdates(); }, []);
  if (!isTauri()) return null;
  const busy = updateBusy(state.phase);
  const percent = state.total && state.total > 0 ? Math.min(100, Math.round(state.downloaded / state.total * 100)) : null;
  return (
    <Dialog open={info.open} title="App updates" onClose={closeUpdates} dismissible={state.phase !== "installing"} footer={<>
      <Button onClick={closeUpdates} disabled={state.phase === "installing"}>Later</Button>
      {state.phase === "ready" ? <Button variant="primary" onClick={() => void installUpdate()}>Install and restart</Button>
        : state.phase === "available" ? <Button variant="primary" onClick={() => void updates.download()}>Download update</Button>
        : state.phase === "downloading" ? <Button busy>Downloading…</Button>
        : state.phase === "installing" ? <Button busy>Installing…</Button>
        : <Button variant="primary" busy={state.phase === "checking"} disabled={!info.supported || busy} onClick={() => void updates.check()}>Check for updates</Button>}
    </>}>
      <Group>
        <InfoRow label="Installed version">{info.version}</InfoRow>
        <SelectRow label="Update channel" value={state.channel} options={[{ value: "stable", label: "Stable" }, { value: "dev", label: "Dev" }]} onChange={chooseUpdateChannel} disabled={busy} />
        <SwitchRow label="Check automatically" checked={info.auto} onChange={setAutomaticChecks} disabled={state.phase === "installing"} />
      </Group>
      <p className="muted small">{state.channel === "dev" ? "Dev builds contain the latest changes and may have unfinished features." : "Stable releases only. Switching from Dev waits for a newer stable version; it does not downgrade the app."}</p>
      <div className="update-status" role="status" aria-live="polite">
        {!info.ready ? "Loading update settings…" : state.phase === "checking" ? "Checking for updates…"
          : state.phase === "current" ? "You have the latest version available in this channel."
          : state.phase === "downloading" ? `Downloading${percent === null ? "…" : ` · ${percent}%`} · ${(state.downloaded / 1_048_576).toFixed(1)} MB`
          : state.phase === "ready" ? "Downloaded and verified. Ready to install."
          : state.phase === "installing" ? "Finishing radio requests, saving your data and installing…"
          : state.version ? `Version ${state.version} is available.` : "Check when you have an internet connection."}
      </div>
      {state.phase === "downloading" ? <progress className="update-progress" aria-label="Update download" max={100} value={percent ?? undefined} /> : null}
      {state.version ? <p><strong>Version {state.version}</strong></p> : null}
      {state.notes ? <div className="update-notes">{state.notes}</div> : null}
      {state.phase === "ready" ? <p className="muted small">Installation restarts Meshnet and briefly disconnects your radio. Your history, drafts and settings are kept.</p> : null}
      {state.error || info.error ? <p className="connect-error" role="alert">{state.error ?? info.error}</p> : null}
      {state.checkedAt ? <p className="muted small">Last checked: {new Date(state.checkedAt).toLocaleString()}</p> : null}
    </Dialog>
  );
}
