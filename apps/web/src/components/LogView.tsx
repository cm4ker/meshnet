import { useState } from "react";
import { locale, t } from "../i18n/index.js";
import { useSelector } from "../lib/session.js";
import { isTraceEnabled, setTraceEnabled, useTrace } from "../lib/trace.js";
import { Toggle } from "../ui/Field.js";

export function LogView() {
  const log = useSelector((state) => state.log);
  const trace = useTrace();
  const [tracing, setTracing] = useState(isTraceEnabled);
  const entries = [...log].reverse();
  return (
    <div className="card-scroll">
      <div className="section">
        <header className="section-head">
          <h2>{t("radio.log.events")}</h2>
        </header>
        {entries.length === 0 ? <p className="muted small">{t("radio.log.nothing")}</p> : null}
        <ul className="log">
          {entries.map((e, i) => (
            <li key={`${e.at}-${i}`}>
              <span className="log-when muted">{new Date(e.at).toLocaleTimeString(locale())}</span>
              <span className={`log-kind kind-${e.kind}`}>{e.kind}</span>
              <span className="log-text">{e.text}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="section">
        <header className="section-head">
          <h2>{t("radio.log.frames")}</h2>
        </header>
        <Toggle
          label={t("radio.log.record")}
          hint={t("radio.log.recordHint")}
          checked={tracing}
          onChange={(v) => {
            setTracing(v);
            setTraceEnabled(v);
          }}
        />
        {tracing ? (
          <ul className="log mono">
            {[...trace].reverse().map((f, i) => (
              <li key={`${f.at}-${i}`}>
                <span className="log-when muted">{new Date(f.at).toLocaleTimeString(locale())}</span>
                <span className={`log-kind ${f.direction}`}>{f.direction === "in" ? "←" : "→"} {f.kind}</span>
                <span className="log-text">{f.hex}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
