import { useEffect, useState } from "react";
import { session, useSession } from "../../lib/session.js";

/**
 * What the radio is waiting on. It carries one request to a remote node at
 * a time, so this is where a second click goes to wait, visibly.
 */
export function QueuePill({ nodeKey }: { nodeKey: string }) {
  const state = useSession();
  const { active, queued } = state.remote;
  const [, tick] = useState(0);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => tick((n) => n + 1), 200);
    return () => clearInterval(timer);
  }, [active]);

  if (!active) {
    return (
      <span className="queue" title="Nothing is waiting for a reply">
        <span className="dot" aria-hidden="true" />
        <span className="queue-label">Radio idle</span>
      </span>
    );
  }
  const name = (key: string) => (key === nodeKey ? "" : `${state.contacts[key]?.name ?? key.slice(0, 12)}: `);
  const secs = active.startedAt ? ((Date.now() - active.startedAt) / 1000).toFixed(1) : "0.0";
  const title = [`${name(active.key)}${active.label} (on the air)`, ...queued.map((j) => `${name(j.key)}${j.label}`)].join("\n");
  return (
    <span className="queue busy" title={title} role="status">
      <span className="spinner" aria-hidden="true" />
      <span className="queue-label">
        {name(active.key)}
        {active.label} · {secs} s
      </span>
      {queued.length > 0 ? (
        <button type="button" className="queue-more" title={`${title}\n\nClick to drop the ${queued.length} waiting`} onClick={() => queued.forEach((j) => session.cancelRemote(j.id))}>
          +{queued.length}
        </button>
      ) : null}
    </span>
  );
}
