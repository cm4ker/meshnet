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
import { nameOfHash } from "../../lib/echoes.js";
import { profileBetween } from "../../lib/elevation.js";
import { agoPhrase } from "../../lib/format.js";
import { bearingDeg, compass, distanceKm, formatDistance, hasPosition } from "../../lib/geo.js";
import { lineOfSight, quality, VERDICT_WORDS, type LineOfSight, type LinkRadio, type Profile } from "../../lib/los.js";
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
  return `heard ${agoPhrase(now - heardS * 1000, now)}`;
}

function NeighbourList({ tool }: { tool: NeighboursTool }) {
  const state = useSession();
  const fetch = useNeighbourFetch(tool.key);
  const [offOpen, setOffOpen] = useState(false);
  const hub = state.contacts[tool.key];
  const hubName = hub ? nameOf(hub) : "The repeater";
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
      ? `Asking ${hubName}…`
      : "Not asked yet"
    : complete
      ? `${list.total} heard · ${placed.length} on the map · ${agoPhrase(list.at, now)}`
      : `${list.neighbours.length} of ${list.total} so far`;
  const missing = list ? list.total - list.neighbours.length : 0;

  let progress: React.ReactNode = null;
  if (running && list && !complete) {
    progress = (
      <div className="nb-progress">
        <span className="nb-progress-line">
          Getting the rest · {list.neighbours.length} of {list.total}
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
          {fetch.silent ? `${hubName} did not answer${missing > 0 ? ` · ${missing} not fetched` : ""}` : fetch.error}
          <Button size="sm" disabled={!online} onClick={() => void fetchAllNeighbours(tool.key)}>
            <RefreshIcon size={13} />
            Try again
          </Button>
        </span>
      </div>
    );
  } else if (!running && list && !complete) {
    progress = (
      <div className="nb-progress">
        <span className="nb-progress-line">
          {online ? `${missing} more to fetch` : `${missing} more · connect the radio to fetch them`}
          {online ? (
            <Button size="sm" onClick={() => void fetchAllNeighbours(tool.key)}>
              Get the rest
            </Button>
          ) : null}
        </span>
      </div>
    );
  }

  const pages = Math.max(1, Math.ceil((list?.total ?? PAGE) / PAGE));
  return (
    <div className="tool nb-sheet">
      <SheetHead title={`Neighbours of ${hubName}`} sub={sub} onBack={closeTool} />
      {placed.length ? (
        <div className="nb-summary">
          <span><i className="good" />{counts.good} good</span>
          <span><i className="fair" />{counts.fair} fair</span>
          <span><i className="weak" />{counts.weak} weak</span>
          {off.length ? <span>· {off.length} off the map</span> : null}
        </div>
      ) : null}
      {progress}
      {list && list.total === 0 ? <p className="tool-note muted">It hears no other repeater directly right now.</p> : null}
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
                    <span className={["row-sub", r.stale ? "nb-gone" : "muted"].join(" ")}>{r.stale ? `${heardWhen(r.heardS, now)} · may be gone` : [heardWhen(r.heardS, now), far].filter(Boolean).join(" · ")}</span>
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
            <span className="grow">{off.length} not on the map</span>
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
                        <span className="row-sub muted">no position shared · {heardWhen(r.heardS, now)}</span>
                      </span>
                      <QualityChip snr={r.snr} />
                      <ChevronRightIcon size={14} className="line-chev" />
                    </button>
                  ) : (
                    <div className="row">
                      <Avatar name={r.prefix} type={2} size={32} />
                      <span className="row-main">
                        <span className="row-title mono">{r.prefix}</span>
                        <span className="row-sub muted">not in contacts · {heardWhen(r.heardS, now)}</span>
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
        {running ? "Asking…" : "Ask again"}
      </Button>
      <div className="check-cost">
        <AirIcon size={13} />
        {pages} request{pages === 1 ? "" : "s"} to {hubName} · it keeps up to {KEPT}
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
        <SheetHead title="Link" sub="No longer on the radio" onBack={() => openNeighbourLink(null)} />
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
  const checked = direct && p ? `${agoPhrase(p.at, now)} · checked from your radio` : null;
  const a = contactEnd(hub);
  const b = contactEnd(nb);
  const where = a && b ? `${formatDistance(distanceKm(a.lat, a.lon, b.lat, b.lon))} ${compass(bearingDeg(a.lat, a.lon, b.lat, b.lon))} of ${hubName}` : `${nbName} has shared no position`;
  const signed = !!state.logins[link]?.ok;
  const nbList = state.neighbours[link];
  const openLeg = (index: number) => {
    if (!p) return;
    const ends = chainEnds(p.chain, state);
    const x = ends[index];
    const y = ends[index + 1];
    if (x && y) openLineOfSight(x, y, null, legs[index] ?? null);
  };

  const hubHears = direct?.[1] != null ? { snr: direct[1], hint: checked! } : row ? { snr: row.snr, hint: `${heardWhen(row.heardS, now)} · from ${hubName}'s list` } : null;
  const nbHears = direct ? { snr: direct[0], hint: checked! } : reverse ? { snr: reverse.snr, hint: `${heardWhen(reverse.heardS, now)} · from ${nbName}'s list` } : null;

  return (
    <div className="tool nb-link">
      <div className="tool-head">
        <IconButton label="Back to the list" onClick={() => openNeighbourLink(null)}>
          <BackIcon size={18} />
        </IconButton>
        <span className="row-main">
          <span className="row-title">
            {hubName} — {nbName}
          </span>
          <span className="row-sub muted">{where}</span>
        </span>
        <IconButton label="Close" onClick={closeAllTools}>
          <CloseIcon size={18} />
        </IconButton>
      </div>
      <Group>
        <InfoRow label={`${hubName} hears ${nbName}`} hint={hubHears?.hint ?? "not in the list any more"}>
          {hubHears ? <QualityChip snr={hubHears.snr} /> : <span className="muted">—</span>}
        </InfoRow>
        <InfoRow label={`${nbName} hears ${hubName}`} hint={nbHears?.hint ?? "not known yet"}>
          {nbHears ? <QualityChip snr={nbHears.snr} /> : <span className="muted">—</span>}
        </InfoRow>
      </Group>
      {row?.stale && !direct ? (
        <p className="nb-warn">
          {hubName} last heard {nbName} {agoPhrase(now - row.heardS * 1000, now)}. It may be gone.
        </p>
      ) : null}
      {p ? <CheckResult p={p} names={["You", ...p.chain.map((h) => nameOfHash(h, state.contacts) ?? h)]} reach={null} placed onLeg={openLeg} /> : null}
      <Button variant={running ? "default" : "primary"} size="lg" disabled={!online} onClick={() => (running ? stopPing(key) : void ping(key))}>
        {running ? null : <AirIcon size={16} />}
        {running ? "Stop" : p ? "Check again" : "Check both ways"}
      </Button>
      <div className="check-cost">
        <AirIcon size={13} />
        Up to {ROUNDS} traces from you through {hubName} · each measures both ways
      </div>
      {a && b ? <Terrain a={a} b={b} heard={direct} /> : null}
      <Group>
        <LinkRow icon={<Avatar name={nbName} type={nb.type} size={26} />} label={nbName} hint="Profile" onClick={() => openProfile(link)} />
        <LinkRow
          label={`${nbName}'s neighbours`}
          hint={signed ? (nbList ? `${nbList.total} heard · ${agoPhrase(nbList.at, now)}` : "Not asked yet") : `Sign in to ${nbName} to see them`}
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
          toast(`Signed in to ${nbName}`);
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
  const label = los ? <span className={`nb-verdict ${los.verdict}`}>{VERDICT_WORDS[los.verdict]}</span> : failed ? "Line of sight" : "Reading the terrain…";
  return (
    <Group>
      <LinkRow label={label} hint={`Line of sight · antennas ${ha} m and ${hb} m`} onClick={() => openLineOfSight(a, b, null, heard)} />
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
