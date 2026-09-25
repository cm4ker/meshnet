/**
 * The commands a repeater, room or sensor answers over the air, for the
 * console's suggestions: MeshCore's `CommonCLI.cpp` and `simple_repeater`,
 * and the MeshCoreTel fork's Wi-Fi, MQTT and web panel. Left out are the
 * ones the firmware takes only from its serial port (`erase`, `log`,
 * `stats-*`, `set freq`, `get prv.key`, `get acl`): over the air they answer
 * "Unknown command".
 */

import { t, type Key } from "../i18n/index.js";

export interface CliCommand {
  /** What is typed; it ends in a space when a value follows. */
  text: string;
  /** What the value is, said beside the field once the command is typed: a key, read in the reader's language by `suggest`. */
  arg?: Key;
  /** The values it takes, offered once the command is typed. */
  values?: string[];
}

const ONOFF = ["on", "off"];

/** Settings read with `get` and written with `set`: the key, then what a value is. `get: false` for write-only, `set: false` for read-only. */
interface Setting {
  key: string;
  arg?: Key;
  values?: string[];
  get?: boolean;
  set?: boolean;
}

const SETTINGS: Setting[] = [
  // Radio and airtime.
  { key: "radio", arg: "node.cli.radio" },
  { key: "freq", set: false },
  { key: "tx", arg: "node.cli.dbm" },
  { key: "dutycycle", arg: "node.cli.dutycycle" },
  { key: "af", arg: "node.cli.af" },
  { key: "radio.rxgain", values: ONOFF },
  { key: "int.thresh", arg: "node.cli.intThresh" },
  { key: "agc.reset.interval", arg: "node.cli.agcReset" },
  // Repeating.
  { key: "repeat", values: ONOFF },
  { key: "flood.max", arg: "node.cli.hops" },
  { key: "flood.max.advert", arg: "node.cli.hops" },
  { key: "flood.max.unscoped", arg: "node.cli.hops" },
  { key: "loop.detect", values: ["off", "minimal", "moderate", "strict"] },
  { key: "path.hash.mode", values: ["0", "1", "2"], arg: "node.cli.pathHash" },
  { key: "txdelay", arg: "node.cli.txdelay" },
  { key: "direct.txdelay", arg: "node.cli.txdelay" },
  { key: "rxdelay", arg: "node.cli.rxdelay" },
  { key: "multi.acks", values: ["0", "1"] },
  // Adverts and identity.
  { key: "advert.interval", arg: "node.cli.advertInterval" },
  { key: "flood.advert.interval", arg: "node.cli.floodAdvertInterval" },
  { key: "name", arg: "node.cli.name" },
  { key: "lat", arg: "node.cli.degrees" },
  { key: "lon", arg: "node.cli.degrees" },
  { key: "owner.info", arg: "node.cli.ownerInfo" },
  { key: "public.key", set: false },
  { key: "role", set: false },
  { key: "prv.key", get: false, arg: "node.cli.privateKey" },
  // Access.
  { key: "guest.password", arg: "node.cli.password" },
  { key: "allow.read.only", values: ONOFF },
  // Power and board.
  { key: "adc.multiplier", arg: "node.cli.adcMultiplier" },
  { key: "bootloader.ver", set: false },
  { key: "pwrmgt.support", set: false },
  { key: "pwrmgt.source", set: false },
  { key: "pwrmgt.bootreason", set: false },
  { key: "pwrmgt.bootmv", set: false },
  // Bridge builds.
  { key: "bridge.type", set: false },
  { key: "bridge.enabled", values: ONOFF },
  { key: "bridge.delay", arg: "node.cli.bridgeDelay" },
  { key: "bridge.source", values: ["rx", "tx"] },
  { key: "bridge.baud", arg: "node.cli.bridgeBaud" },
  { key: "bridge.channel", arg: "node.cli.bridgeChannel" },
  { key: "bridge.secret", arg: "node.cli.secret" },
  // MeshCoreTel.
  { key: "cad", values: ONOFF },
  { key: "extra.sf", arg: "node.cli.extraSf" },
  { key: "radio.fem.rxgain", values: ONOFF },
  { key: "radio.fem.txgain", values: ONOFF },
  { key: "fan", values: ["auto", "on", "off", "timeout "] },
  { key: "web", values: ONOFF },
  { key: "web.stats", values: ONOFF, get: false },
  { key: "web.status", set: false },
  { key: "web.stats.status", set: false },
  { key: "wifi.ssid", arg: "node.cli.ssid" },
  { key: "wifi.pwd", arg: "node.cli.password", get: false },
  { key: "wifi.powersaving", values: ["none", "min", "max"] },
  { key: "wifi.status", set: false },
  { key: "mqtt.status", values: ONOFF, get: false },
  { key: "mqtt.statuscfg", set: false },
  { key: "mqtt.client_version", set: false },
  { key: "mqtt.iata", arg: "node.cli.iata" },
  { key: "mqtt.owner", arg: "node.cli.mqttOwner" },
  { key: "mqtt.email", arg: "node.cli.email" },
  { key: "mqtt.packets", values: ONOFF },
  { key: "mqtt.raw", values: ONOFF },
  { key: "mqtt.tx", arg: "node.cli.value" },
  { key: "mqtt.meshcoretel", values: ONOFF },
  { key: "mqtt.letsmesh-eu", values: ONOFF },
  { key: "mqtt.letsmesh-us", values: ONOFF },
];

const PLAIN: CliCommand[] = [
  { text: "ver" },
  { text: "board" },
  { text: "clock" },
  { text: "clock sync" },
  { text: "time ", arg: "node.cli.time" },
  { text: "advert" },
  { text: "advert.zerohop" },
  { text: "neighbors" },
  { text: "discover.neighbors" },
  { text: "neighbor.remove ", arg: "node.cli.publicKey" },
  { text: "clear stats" },
  { text: "powersaving" },
  { text: "powersaving ", values: ONOFF },
  { text: "tempradio ", arg: "node.cli.tempradio" },
  { text: "password ", arg: "node.cli.newPassword" },
  { text: "setperm ", arg: "node.cli.setperm" },
  { text: "log start" },
  { text: "log stop" },
  { text: "log erase" },
  { text: "sensor list" },
  { text: "sensor get ", arg: "node.cli.key" },
  { text: "sensor set ", arg: "node.cli.keyValue" },
  { text: "gps" },
  { text: "gps ", values: ["on", "off", "sync", "setloc", "advert"] },
  { text: "gps advert ", values: ["none", "share", "prefs"] },
  { text: "region" },
  { text: "region ", values: ["load", "save", "home", "default", "get ", "put ", "remove ", "allowf ", "denyf ", "list ", "def "] },
  { text: "region home ", arg: "node.cli.region" },
  { text: "region default ", arg: "node.cli.regionDefault" },
  { text: "region get ", arg: "node.cli.region" },
  { text: "region put ", arg: "node.cli.regionPut" },
  { text: "region remove ", arg: "node.cli.region" },
  { text: "region allowf ", arg: "node.cli.region" },
  { text: "region denyf ", arg: "node.cli.region" },
  { text: "region list ", values: ["allowed", "denied"] },
  { text: "region def ", arg: "node.cli.regionTree" },
  { text: "reboot" },
  { text: "clkreboot" },
  { text: "poweroff" },
  { text: "start ota" },
  // MeshCoreTel.
  { text: "memory" },
  { text: "eth.status" },
  { text: "send mqtt.status" },
  { text: "time.force ", arg: "node.cli.epochSeconds" },
];

export const COMMANDS: CliCommand[] = [
  ...PLAIN,
  ...SETTINGS.filter((s) => s.get !== false).map((s) => ({ text: `get ${s.key}` })),
  ...SETTINGS.filter((s) => s.set !== false).map((s): CliCommand => ({ text: `set ${s.key} `, ...(s.arg ? { arg: s.arg } : {}), ...(s.values ? { values: s.values } : {}) })),
];

/** Offered before anything is typed. */
const FIRST = ["ver", "clock", "neighbors", "get radio", "get dutycycle", "advert"];

export interface Suggestion {
  /** What the chip says. */
  label: string;
  /** What a tap puts in the field. */
  fill: string;
}

/**
 * What to offer for what is typed so far. Typed up to a command that takes
 * a value: the values it takes, and what a value is. Otherwise the commands
 * that start with it, then those with it anywhere in them, so "duty" finds
 * both `get dutycycle` and `set dutycycle`.
 */
export function suggest(draft: string, limit = 12): { chips: Suggestion[]; hint: string | null } {
  const typed = draft.replace(/^\s+/, "").replace(/\s+/g, " ").toLowerCase();
  if (typed.trim() === "") return { chips: FIRST.map((c) => ({ label: c, fill: c })), hint: null };
  // The longest command typed in full, with its value to come or on its way; "set repeat" is as good as "set repeat ".
  const full = COMMANDS.some((c) => c.values && c.text === `${typed} `) ? `${typed} ` : typed;
  const at = COMMANDS.filter((c) => c.text.endsWith(" ") && full.startsWith(c.text) && (c.arg || c.values)).sort((a, b) => b.text.length - a.text.length)[0];
  if (at) {
    const rest = full.slice(at.text.length);
    const deeper = COMMANDS.some((c) => c !== at && c.text.startsWith(full) && c.text.length > full.length);
    if (!deeper || rest.length > 0 || at.values) {
      const chips = (at.values ?? []).filter((v) => v.startsWith(rest) && v !== rest).map((v) => ({ label: v.trim(), fill: at.text + v }));
      return { chips, hint: at.arg ? t(at.arg) : null };
    }
  }
  const word = typed.trim();
  const starts = COMMANDS.filter((c) => c.text.startsWith(typed) && c.text.trim() !== word);
  const inside = word.length >= 2 ? COMMANDS.filter((c) => !c.text.startsWith(typed) && c.text.includes(word)) : [];
  const seen = new Set<string>();
  const chips: Suggestion[] = [];
  for (const c of [...starts, ...inside]) {
    const label = c.text.trim();
    if (seen.has(label)) continue;
    seen.add(label);
    chips.push({ label, fill: c.text });
    if (chips.length >= limit) break;
  }
  return { chips, hint: null };
}
