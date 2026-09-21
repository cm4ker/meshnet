import { useState } from "react";
import { useSession } from "../lib/session.js";
import { isTraceEnabled, setTraceEnabled, useTrace } from "../lib/trace.js";
import { Toggle } from "../ui/Field.js";

export function LogView() {
  const state = useSession();
  const trace = useTrace();
  const [tracing, setTracing] = useState(isTraceEnabled);
  const entries = [...state.log].reverse();
  return (
    <div className="card-scroll">
      <div className="section">
        <header className="section-head">
          <h2>Events</h2>
        </header>
        {entries.length === 0 ? <p className="muted small">Nothing yet.</p> : null}
        <ul className="log">
          {entries.map((e, i) => (
            <li key={`${e.at}-${i}`}>
              <span className="log-when muted">{new Date(e.at).toLocaleTimeString()}</span>
              <span className={`log-kind kind-${e.kind}`}>{e.kind}</span>
              <span className="log-text">{e.text}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="section">
        <header className="section-head">
          <h2>Frames</h2>
        </header>
        <Toggle
          label="Record every frame"
          hint="Hex of what crosses the link, for reading the protocol."
          checked={tracing}
          onChange={(v) => {
            setTracing(v);
            setTraceEnabled(v);
          }}
        />
        {tracing ? (
          <ul className="log mono">
            {[...trace].reverse().map((t, i) => (
              <li key={`${t.at}-${i}`}>
                <span className="log-when muted">{new Date(t.at).toLocaleTimeString()}</span>
                <span className={`log-kind ${t.direction}`}>{t.direction === "in" ? "←" : "→"} {t.kind}</span>
                <span className="log-text">{t.hex}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
