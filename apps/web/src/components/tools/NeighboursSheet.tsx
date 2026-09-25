/**
 * A repeater's neighbours over the map: how many it hears and how well, the
 * list strongest first, and the rest of it on its way. A neighbour tapped,
 * in the list or on the map, opens the link between the two: how each hears
 * the other, a check both ways from this radio, and the terrain between.
 * Back steps from the link to the list, and from the list to where it was
 * opened from.
 */

import { useEffect, useState } from "react";
import type { ContactRecord } from "@meshnet/meshcore";
import { t } from "../../i18n/index.js";
import { nameOfHash } from "../../lib/echoes.js";
import { profileBetween } from "../../lib/elevation.js";
import { agoPhrase } from "../../lib/format.js";
import { bearingDeg, compass, distanceKm, formatDistance, hasPosition } from "../../lib/geo.js";
import { lineOfSight, quality, verdictWord, type LineOfSight, type LinkRadio, type Profile } from "../../lib/los.js";
import { contactEnd } from "../../lib/mapOverlay.js";
import type { LosEnd, NeighboursTool } from "../../lib/meshTool.js";
import { openProfile } from "../../lib/nav.js";
import { fetchAllNeighbours, useNeighbourFetch } from "../../lib/neighbourFetch.js";
import { heardInList, isComplete, neighbourRows, PAGE, type NeighbourRow } from "../../lib/neighbours.js";
import { measuredLegs, ping, ROUNDS, spanKey, stopPing, usePing } from "../../lib/ping.js";
import { useSession } from "../../lib/session.js";
import { toast } from "../../lib/toast.js";
import { closeAllTools, closeTool, openLineOfSight, openNeighbourLink, openNeighboursOf } from "../../lib/toolActions.js";
import { Button, IconButton } from "../../ui/Button.js";
import { Group, InfoRow, LinkRow } from "../../ui/List.js";
import { Avatar } from "../Avatar.js";
import { AirIcon, BackIcon, ChevronDownIcon, ChevronRightIcon, CloseIcon, LockIcon, RefreshIcon } from "../Icons.js";
import { SignIn } from "../node/SignIn.js";
import { antennaHeight } from "./LosView.js";
import { chainEnds, CheckResult, QualityChip, SheetHead } from "./RouteSheet.js";

/** The firmware keeps this many neighbours at most. */
const KEPT = 50;

export function NeighboursSheet({ tool }: { tool: NeighboursTool }) {
  return tool.link ? <LinkCard key={tool.link} tool={tool} link={tool.link} /> : <NeighbourList tool={tool} />;
}

const nameOf = (c: ContactRecord) => c.name || c.prefix;

function heardWhen(heardS: number, now: number): string {
  return t("tools.nb.heard", { time: agoPhrase(now - heardS * 1000, now) });
}

function NeighbourList({ tool }: { tool: NeighboursTool }) {
  const state = useSession();
  const fetch = useNeighbourFetch(tool.key);
  const [offOpen, setOffOpen] = useState(false);
  const hub = state.contacts[tool.key];
  const hubName = hub ? nameOf(hub) : t("tools.nb.theRepeater");
  const list = state.neighbours[tool.key];
  const now = Date.now();
  const rows = neighbourRows(state, tool.key, now);
  const placed = rows.filter((r) => r.placed);
  const off = rows.filter((r) => !r.placed);
  const online = state.status === "ready";
  const running = fetch?.running ?? false;
  const complete = isComplete(list);
  const counts = { good: 0, fair: 0, weak: 0 };
  for (const r of placed) counts[quality(r.snr)]++;
  const away = (r: NeighbourRow) => (hub && r.contact && hasPosition(hub.lat, hub.lon) ? formatDistance(distanceKm(hub.lat, hub.lon, r.contact.lat, r.contact.lon)) : null);

  const sub = !list
    ? running
      ? t("tools.nb.asking", { name: hubName })
      : t("tools.nb.notAsked")
    : complete
      ? t("tools.nb.subComplete", { total: list.total, placed: placed.length, time: agoPhrase(list.at, now) })
      : t("tools.nb.soFar", { count: list.neighbours.length, total: list.total });
  const missing = list ? list.total - list.neighbours.length : 0;

  let progress: React.ReactNode = null;
  if (running && list && !complete) {
    progress = (
      <div className="nb-progress">
        <span className="nb-progress-line">
          {t("tools.nb.gettingRest", { count: list.neighbours.length, total: list.total })}
          <span className="spinner" aria-hidden="true" />
        </span>
        <span className="nb-progress-bar" aria-hidden="true">
          <i style={{ width: `${(list.neighbours.length / Math.max(1, list.total)) * 100}%` }} />
        </span>
      </div>
    );
  } else if (!running && fetch?.error) {
    progress = (
      <div className="nb-progress bad">
        <span className="nb-progress-line">
          {fetch.silent ? (missing > 0 ? t("tools.nb.noAnswerMissing", { name: hubName, missing }) : t("tools.nb.noAnswer", { name: hubName })) : fetch.error}
          <Button size="sm" disabled={!online} onClick={() => void fetchAllNeighbours(tool.key)}>
            <RefreshIcon size={13} />
            {t("common.tryAgain")}
          </Button>
        </span>
      </div>
    );
  } else if (!running && list && !complete) {
    progress = (
      <div className="nb-progress">
        <span className="nb-progress-line">
          {online ? t("tools.nb.moreToFetch", { count: missing }) : t("tools.nb.moreOffline", { count: missing })}
          {online ? (
            <Button size="sm" onClick={() => void fetchAllNeighbours(tool.key)}>
              {t("tools.nb.getRest")}
            </Button>
          ) : null}
        </span>
      </div>
    );
  }

  const pages = Math.max(1, Math.ceil((list?.total ?? PAGE) / PAGE));
  return (
    <div className="tool nb-sheet">
      <SheetHead title={t("tools.nb.title", { name: hubName })} sub={sub} onBack={closeTool} />
      {placed.length ? (
        <div className="nb-summary">
          <span><i className="good" />{t("tools.nb.good", { count: counts.good })}</span>
          <span><i className="fair" />{t("tools.nb.fair", { count: counts.fair })}</span>
          <span><i className="weak" />{t("tools.nb.weak", { count: counts.weak })}</span>
          {off.length ? <span>· {t("tools.nb.offMap", { count: off.length })}</span> : null}
        </div>
      ) : null}
      {progress}
      {list && list.total === 0 ? <p className="tool-note muted">{t("tools.nb.none")}</p> : null}
      {placed.length ? (
        <ul className="list-rows nb-rows" role="list">
          {placed.map((r) => {
            const c = r.contact!;
            const far = away(r);
            return (
              <li key={r.prefix}>
                <button type="button" className="row" onClick={() => openNeighbourLink(c.key)}>
                  <Avatar name={nameOf(c)} type={c.type} size={32} />
                  <span className="row-main">
                    <span className="row-title">{nameOf(c)}</span>
                    <span className={["row-sub", r.stale ? "nb-gone" : "muted"].join(" ")}>{r.stale ? t("tools.nb.mayBeGone", { heard: heardWhen(r.heardS, now) }) : [heardWhen(r.heardS, now), far].filter(Boolean).join(" · ")}</span>
                  </span>
                  <QualityChip snr={r.snr} />
                  <ChevronRightIcon size={14} className="line-chev" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {off.length ? (
        <>
          <button type="button" className="nb-off-toggle" aria-expanded={offOpen} onClick={() => setOffOpen(!offOpen)}>
            <span className="grow">{t("tools.nb.notOnMap", { count: off.length })}</span>
            {offOpen ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
          </button>
          {offOpen ? (
            <ul className="list-rows nb-rows" role="list">
              {off.map((r) => (
                <li key={r.prefix}>
                  {r.contact ? (
                    <button type="button" className="row" onClick={() => openNeighbourLink(r.contact!.key)}>
                      <Avatar name={nameOf(r.contact)} type={r.contact.type} size={32} />
                      <span className="row-main">
                        <span className="row-title">{nameOf(r.contact)}</span>
                        <span className="row-sub muted">{t("tools.nb.noPosition", { heard: heardWhen(r.heardS, now) })}</span>
                      </span>
                      <QualityChip snr={r.snr} />
                      <ChevronRightIcon size={14} className="line-chev" />
                    </button>
                  ) : (
                    <div className="row">
                      <Avatar name={r.prefix} type={2} size={32} />
                      <span className="row-main">
                        <span className="row-title mono">{r.prefix}</span>
                        <span className="row-sub muted">{t("tools.nb.notContact", { heard: heardWhen(r.heardS, now) })}</span>
                      </span>
                      <QualityChip snr={r.snr} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      <Button size="lg" busy={running} disabled={!online} onClick={() => void fetchAllNeighbours(tool.key, true)}>
        <RefreshIcon size={16} />
        {running ? t("tools.nb.askingButton") : t("tools.askAgain")}
      </Button>
      <div className="check-cost">
        <AirIcon size={13} />
        {t("tools.nb.cost", { count: pages, name: hubName, max: KEPT })}
      </div>
    </div>
  );
}

function LinkCard({ tool, link }: { tool: NeighboursTool; link: string }) {
  const state = useSession();
  const [signing, setSigning] = useState(false);
  const key = spanKey(tool.key, link);
  const p = usePing(key);
  const hub = state.contacts[tool.key];
  const nb = state.contacts[link];
  if (!hub || !nb) {
    return (
      <div className="tool">
        <SheetHead title={t("tools.link.title")} sub={t("tools.link.gone")} onBack={() => openNeighbourLink(null)} />
      </div>
    );
  }
  const now = Date.now();
  const hubName = nameOf(hub);
  const nbName = nameOf(nb);
  const online = state.status === "ready";
  const row = neighbourRows(state, tool.key, now).find((r) => r.contact?.key === link) ?? null;
  const reverse = heardInList(state, link, tool.key, now);
  const running = p?.running ?? false;
  const legs = measuredLegs(p);
  // The leg between the two, when the check went straight from one to the other: out is how the neighbour heard it, back how the repeater did.
  const direct = p && p.from >= 0 && p.chain.length === p.from + 2 ? (legs[p.from + 1] ?? null) : null;
  const checked = direct && p ? t("tools.link.checked", { time: agoPhrase(p.at, now) }) : null;
  const a = contactEnd(hub);
  const b = contactEnd(nb);
  const where = a && b ? t("tools.link.where", { distance: formatDistance(distanceKm(a.lat, a.lon, b.lat, b.lon)), direction: compass(bearingDeg(a.lat, a.lon, b.lat, b.lon)), name: hubName }) : t("tools.link.noPosition", { name: nbName });
  const signed = !!state.logins[link]?.ok;
  const nbList = state.neighbours[link];
  const openLeg = (index: number) => {
    if (!p) return;
    const ends = chainEnds(p.chain, state);
    const x = ends[index];
    const y = ends[index + 1];
    if (x && y) openLineOfSight(x, y, null, legs[index] ?? null);
  };

  const hubHears = direct?.[1] != null ? { snr: direct[1], hint: checked! } : row ? { snr: row.snr, hint: t("tools.link.fromList", { heard: heardWhen(row.heardS, now), name: hubName }) } : null;
  const nbHears = direct ? { snr: direct[0], hint: checked! } : reverse ? { snr: reverse.snr, hint: t("tools.link.fromList", { heard: heardWhen(reverse.heardS, now), name: nbName }) } : null;

  return (
    <div className="tool nb-link">
      <div className="tool-head">
        <IconButton label={t("tools.link.backToList")} onClick={() => openNeighbourLink(null)}>
          <BackIcon size={18} />
        </IconButton>
        <span className="row-main">
          <span className="row-title">
            {hubName} — {nbName}
          </span>
          <span className="row-sub muted">{where}</span>
        </span>
        <IconButton label={t("common.close")} onClick={closeAllTools}>
          <CloseIcon size={18} />
        </IconButton>
      </div>
      <Group>
        <InfoRow label={t("tools.link.hears", { a: hubName, b: nbName })} hint={hubHears?.hint ?? t("tools.link.notInList")}>
          {hubHears ? <QualityChip snr={hubHears.snr} /> : <span className="muted">—</span>}
        </InfoRow>
        <InfoRow label={t("tools.link.hears", { a: nbName, b: hubName })} hint={nbHears?.hint ?? t("tools.link.notKnown")}>
          {nbHears ? <QualityChip snr={nbHears.snr} /> : <span className="muted">—</span>}
        </InfoRow>
      </Group>
      {row?.stale && !direct ? (
        <p className="nb-warn">{t("tools.link.stale", { hub: hubName, nb: nbName, time: agoPhrase(now - row.heardS * 1000, now) })}</p>
      ) : null}
      {p ? <CheckResult p={p} names={[t("tools.you"), ...p.chain.map((h) => nameOfHash(h, state.contacts) ?? h)]} reach={null} placed onLeg={openLeg} /> : null}
      <Button variant={running ? "default" : "primary"} size="lg" disabled={!online} onClick={() => (running ? stopPing(key) : void ping(key))}>
        {running ? null : <AirIcon size={16} />}
        {running ? t("tools.stop") : p ? t("tools.link.checkAgain") : t("tools.link.checkBoth")}
      </Button>
      <div className="check-cost">
        <AirIcon size={13} />
        {t("tools.link.cost", { count: ROUNDS, name: hubName })}
      </div>
      {a && b ? <Terrain a={a} b={b} heard={direct} /> : null}
      <Group>
        <LinkRow icon={<Avatar name={nbName} type={nb.type} size={26} />} label={nbName} hint={t("tools.link.profile")} onClick={() => openProfile(link)} />
        <LinkRow
          label={t("tools.link.neighbours", { name: nbName })}
          hint={signed ? (nbList ? t("tools.link.neighboursHint", { total: nbList.total, time: agoPhrase(nbList.at, now) }) : t("tools.nb.notAsked")) : t("tools.link.signInToSee", { name: nbName })}
          trailing={signed ? undefined : <LockIcon size={14} className="line-chev" />}
          disabled={!signed && !online}
          onClick={() => (signed ? openNeighboursOf(link) : setSigning(true))}
        />
      </Group>
      <SignIn
        open={signing}
        nodeKey={link}
        onClose={() => setSigning(false)}
        onSignedIn={() => {
          setSigning(false);
          toast(t("tools.signedIn", { name: nbName }));
          openNeighboursOf(link);
        }}
      />
    </div>
  );
}

/** The ground between the two, small, with what the line of sight makes of it; a tap opens it whole. */
function Terrain({ a, b, heard }: { a: LosEnd; b: LosEnd; heard: [number, number | null] | null }) {
  const state = useSession();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setProfile(null);
    setFailed(false);
    profileBetween(a, b)
      .then((p) => live && setProfile(p))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
    // A new pair of ends reads the terrain again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.lat, a.lon, b.lat, b.lon]);
  const self = state.self;
  const radio: LinkRadio | null = self ? { frequencyKhz: self.frequencyKhz, bandwidthHz: self.bandwidthHz, spreadingFactor: self.spreadingFactor, codingRate: self.codingRate, txPowerDbm: self.txPower } : null;
  const ha = antennaHeight(a, state.contacts);
  const hb = antennaHeight(b, state.contacts);
  const los = profile && radio ? lineOfSight(profile, ha, hb, radio) : null;
  const label = los ? <span className={`nb-verdict ${los.verdict}`}>{verdictWord(los.verdict)}</span> : failed ? t("tools.los.title") : t("tools.los.reading");
  return (
    <Group>
      <LinkRow label={label} hint={t("tools.link.losHint", { a: ha, b: hb })} onClick={() => openLineOfSight(a, b, null, heard)} />
      {los ? (
        <div className="nb-terrain">
          <MiniProfile los={los} />
        </div>
      ) : null}
    </Group>
  );
}

function MiniProfile({ los }: { los: LineOfSight }) {
  const W = 300;
  const H = 56;
  const pts = los.points;
  const D = pts.at(-1)!.d || 1;
  const lo = Math.min(...pts.map((p) => p.ground)) - 4;
  const hi = Math.max(...pts.map((p) => Math.max(p.ground, p.line + p.fresnel))) + 4;
  const X = (d: number) => (d / D) * W;
  const Y = (h: number) => H - ((h - lo) / Math.max(1, hi - lo)) * H;
  const f = (v: number) => v.toFixed(1);
  const ground = pts.map((p) => `${f(X(p.d))},${f(Y(p.ground))}`).join(" ");
  const zone = [...pts.map((p) => `${f(X(p.d))},${f(Y(p.line + p.fresnel))}`), ...[...pts].reverse().map((p) => `${f(X(p.d))},${f(Y(p.line - p.fresnel))}`)].join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <polygon className="los-zone" points={zone} />
      <polygon className="los-ground" points={`0,${H} ${ground} ${W},${H}`} />
      <line className="los-line" x1={0} y1={f(Y(pts[0]!.line))} x2={W} y2={f(Y(pts.at(-1)!.line))} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
