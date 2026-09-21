import { useState } from "react";
import { lppTypeName, NoReplyError, type ContactRecord, type SeriesSummary } from "@meshnet/meshcore";
import { ago } from "../../lib/format.js";
import { session, useSession } from "../../lib/session.js";
import { Button } from "../../ui/Button.js";
import { Section } from "../../ui/Field.js";
import { RefreshIcon } from "../Icons.js";

const WINDOWS = [
  { secs: 3600, label: "Last hour" },
  { secs: 86_400, label: "24 hours" },
  { secs: 7 * 86_400, label: "7 days" },
];

/** A scale that fits the usual range of each kind of reading; a value outside it widens it. */
const SCALES: Record<string, { lo: number; hi: number; unit: string; digits: number }> = {
  temperature: { lo: -20, hi: 40, unit: "°C", digits: 1 },
  humidity: { lo: 0, hi: 100, unit: "%", digits: 0 },
  barometer: { lo: 950, hi: 1050, unit: "hPa", digits: 1 },
  voltage: { lo: 3, hi: 4.3, unit: "V", digits: 2 },
  current: { lo: 0, hi: 1, unit: "A", digits: 3 },
  luminosity: { lo: 0, hi: 1000, unit: "lx", digits: 0 },
  percentage: { lo: 0, hi: 100, unit: "%", digits: 0 },
};

export function History({ contact }: { contact: ContactRecord }) {
  const state = useSession();
  const key = contact.key;
  const record = state.series[key];
  const online = state.status === "ready";
  const [windowSecs, setWindowSecs] = useState(record?.windowSecs ?? 86_400);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = async (secs: number) => {
    setBusy(true);
    setError(null);
    try {
      await session.requestSeries(key, secs);
    } catch (e) {
      setError(e instanceof NoReplyError ? `${e.message}. The sensor may be out of range; try again.` : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const shown = record && record.windowSecs === windowSecs ? record : null;

  return (
    <div className="card-scroll">
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Window">
          {WINDOWS.map((w) => (
            <button key={w.secs} type="button" className={windowSecs === w.secs ? "on" : ""} disabled={busy} onClick={() => setWindowSecs(w.secs)}>
              {w.label}
            </button>
          ))}
        </div>
        <span className="row-actions">
          <span className="muted small">{shown ? `answered ${ago(shown.at)}` : "not asked yet"}</span>
          <Button size="sm" busy={busy} disabled={!online} onClick={() => void ask(windowSecs)}>
            <RefreshIcon size={13} />
            Ask the sensor
          </Button>
        </span>
      </div>
      {error ? <p className="connect-error">{error}</p> : null}
      {shown ? (
        shown.series.length === 0 ? (
          <p className="muted">The sensor has nothing recorded for this window.</p>
        ) : (
          <Section title="Min, average, max">
            <div className="ranges">
              {shown.series.map((s, i) => (
                <RangeRow key={i} summary={s} />
              ))}
            </div>
          </Section>
        )
      ) : (
        <p className="muted">One request brings back, for each series the sensor records, its lowest, highest and mean value over the window.</p>
      )}
      <p className="field-hint">The bar spans min to max and the tick is the mean. Each row has its own scale, labelled at both ends. One window is one request.</p>
    </div>
  );
}

function RangeRow({ summary }: { summary: SeriesSummary }) {
  const kind = lppTypeName(summary.lppType);
  const scale = SCALES[kind] ?? { lo: summary.min, hi: summary.max, unit: "", digits: 2 };
  let lo = Math.min(scale.lo, summary.min);
  let hi = Math.max(scale.hi, summary.max);
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const p = (v: number) => ((v - lo) / (hi - lo)) * 100;
  const d = scale.digits;
  const label = kind === "unknown" ? `type ${summary.lppType}` : kind.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
  return (
    <div className="range">
      <span className="range-name">
        <span>{label}</span>
        <span className="muted small">
          ch {summary.channel}
          {scale.unit ? ` · ${scale.unit}` : ""}
        </span>
      </span>
      <span className="range-plot" title={`min ${summary.min} · mean ${summary.avg} · max ${summary.max} ${scale.unit}`}>
        <span className="range-track">
          <span className="range-band" style={{ left: `${p(summary.min)}%`, width: `${Math.max(0.8, p(summary.max) - p(summary.min))}%` }} />
          <span className="range-avg" style={{ left: `${p(summary.avg)}%` }} />
        </span>
        <span className="range-scale">
          <span>{Number(lo.toFixed(d))}</span>
          <span>{Number(hi.toFixed(d))}</span>
        </span>
      </span>
      <span className="range-values">
        <b>{summary.avg.toFixed(d)}</b> <span className="muted">mean</span>
        <br />
        <span className="muted small">
          {summary.min.toFixed(d)} – {summary.max.toFixed(d)}
        </span>
      </span>
    </div>
  );
}
