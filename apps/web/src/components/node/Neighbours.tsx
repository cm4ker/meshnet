import { useState } from "react";
import { NeighbourOrder, NoReplyError, type ContactRecord } from "@meshnet/meshcore";
import { errorText } from "../../i18n/errors.js";
import { t, type Key } from "../../i18n/index.js";
import { ago } from "../../lib/format.js";
import { quality } from "../../lib/los.js";
import { session, useSession } from "../../lib/session.js";
import { openNeighbours } from "../../lib/toolActions.js";
import { Button } from "../../ui/Button.js";
import { Avatar } from "../Avatar.js";
import { DownIcon, MapIcon, RefreshIcon } from "../Icons.js";

const ORDERS: { order: number; label: Key }[] = [
  { order: NeighbourOrder.Newest, label: "node.neighbours.newest" },
  { order: NeighbourOrder.Strongest, label: "node.neighbours.strongest" },
  { order: NeighbourOrder.Weakest, label: "node.neighbours.weakest" },
  { order: NeighbourOrder.Oldest, label: "node.neighbours.oldest" },
];

/** The SNR bars share one scale, marked at zero. */
const SNR_LOW = -20;
const SNR_HIGH = 15;

export function Neighbours({ contact }: { contact: ContactRecord }) {
  const state = useSession();
  const key = contact.key;
  const list = state.neighbours[key];
  const online = state.status === "ready";
  const [order, setOrder] = useState<number>(list?.order ?? NeighbourOrder.Newest);
  const [busy, setBusy] = useState<"page" | "more" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetch = async (nextOrder: number, offset: number) => {
    setBusy(offset > 0 ? "more" : "page");
    setError(null);
    try {
      await session.requestNeighbours(key, { order: nextOrder, offset });
    } catch (e) {
      setError(e instanceof NoReplyError ? t("node.neighbours.noReply", { seconds: /(\d+) s$/.exec(e.message)?.[1] ?? "?" }) : errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const pct = (snr: number) => ((Math.max(SNR_LOW, Math.min(SNR_HIGH, snr)) - SNR_LOW) / (SNR_HIGH - SNR_LOW)) * 100;
  const rows = list?.neighbours ?? [];
  const more = list ? list.total - rows.length : 0;

  return (
    <div className="card-scroll">
      <div className="toolbar">
        <div className="segmented" role="group" aria-label={t("node.neighbours.order")}>
          {ORDERS.map((o) => (
            <button
              key={o.order}
              type="button"
              className={order === o.order ? "on" : ""}
              disabled={!online || busy !== null}
              onClick={() => {
                setOrder(o.order);
                void fetch(o.order, 0);
              }}
            >
              {t(o.label)}
            </button>
          ))}
        </div>
        <span className="row-actions">
          <span className="muted small">{list ? t("node.neighbours.summary", { total: list.total, shown: rows.length, time: ago(list.at) }) : t("node.notAskedYet")}</span>
          <Button size="sm" busy={busy === "page"} disabled={!online} onClick={() => void fetch(order, 0)}>
            <RefreshIcon size={13} />
            {list ? t("node.refresh") : t("node.neighbours.ask")}
          </Button>
          <Button size="sm" disabled={!online && !list?.neighbours.length} onClick={() => openNeighbours(key)}>
            <MapIcon size={13} />
            {t("node.neighbours.onMap")}
          </Button>
        </span>
      </div>

      {error ? <p className="connect-error">{error}</p> : null}

      {list ? (
        rows.length === 0 ? (
          <p className="muted">{t("node.neighbours.none")}</p>
        ) : (
          <section className="section">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t("node.neighbours.repeater")}</th>
                    <th>
                      {t("node.neighbours.snr")} <span className="table-unit">{t("node.neighbours.scale", { low: SNR_LOW, high: SNR_HIGH })}</span>
                    </th>
                    <th>{t("node.neighbours.heard")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const known = session.contactByPrefix(r.prefix);
                    return (
                      <tr key={r.prefix}>
                        <td>
                          <span className="who">
                            <Avatar name={known?.name || r.prefix} type={known?.type ?? 2} size={26} />
                            <span className="who-text">
                              <span>{known?.name || <code>{r.prefix}</code>}</span>
                              <span className="muted small">{known ? <code>{r.prefix}</code> : t("node.notInContacts")}</span>
                            </span>
                          </span>
                        </td>
                        <td>
                          <span className="snr" title={t("node.unit.decibels", { value: r.snr.toFixed(2) })}>
                            <span className="snr-track">
                              <i className={quality(r.snr)} style={{ width: `${pct(r.snr)}%` }} />
                              <span className="snr-zero" style={{ left: `${pct(0)}%` }} />
                            </span>
                            <span className="snr-value">{t("node.unit.decibels", { value: `${r.snr > 0 ? "+" : ""}${r.snr.toFixed(2)}` })}</span>
                          </span>
                        </td>
                        <td className="muted">{ago(Date.now() - r.heardSecsAgo * 1000)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )
      ) : (
        <p className="muted">{t("node.neighbours.intro")}</p>
      )}

      <div className="row-actions wrap">
        {more > 0 ? (
          <Button size="sm" busy={busy === "more"} disabled={!online} onClick={() => void fetch(list!.order, rows.length)}>
            <DownIcon size={13} />
            {t("node.neighbours.loadMore", { count: Math.min(more, 10) })}
          </Button>
        ) : null}
        <span className="field-hint">{t("node.neighbours.hint")}</span>
      </div>
    </div>
  );
}
