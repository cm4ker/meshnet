/**
 * The commands a repeater, room or sensor answers over the air, for the
 * console's suggestions: MeshCore's `CommonCLI.cpp` and `simple_repeater`,
 * and the MeshCoreTel fork's Wi-Fi, MQTT and web panel. Left out are the
 * ones the firmware takes only from its serial port (`erase`, `log`,
 * `stats-*`, `set freq`, `get prv.key`, `get acl`): over the air they answer
 * "Unknown command".
 */

export interface CliCommand {
  /** What is typed; it ends in a space when a value follows. */
  text: string;
  /** What the value is, said beside the field once the command is typed. */
  arg?: string;
  /** The values it takes, offered once the command is typed. */
  values?: string[];
}

const ONOFF = ["on", "off"];

/** Settings read with `get` and written with `set`: the key, then what a value is. `get: false` for write-only, `set: false` for read-only. */
interface Setting {
  key: string;
  arg?: string;
  values?: string[];
  get?: boolean;
  set?: boolean;
}

const SETTINGS: Setting[] = [
  // Radio and airtime.
  { key: "radio", arg: "freq,bw,sf,cr — e.g. 869.525,250,11,5; reboot to apply" },
  { key: "freq", set: false },
  { key: "tx", arg: "dBm" },
  { key: "dutycycle", arg: "1–100, % of airtime it may use" },
  { key: "af", arg: "airtime factor, e.g. 1.0" },
  { key: "radio.rxgain", values: ONOFF },
  { key: "int.thresh", arg: "interference threshold; 0 is off" },
  { key: "agc.reset.interval", arg: "seconds, rounded to 4; 0 is off" },
  // Repeating.
  { key: "repeat", values: ONOFF },
  { key: "flood.max", arg: "hops, 0–64" },
  { key: "flood.max.advert", arg: "hops, 0–64" },
  { key: "flood.max.unscoped", arg: "hops, 0–64" },
  { key: "loop.detect", values: ["off", "minimal", "moderate", "strict"] },
  { key: "path.hash.mode", values: ["0", "1", "2"], arg: "hash size less one: 0 is 1 byte" },
  { key: "txdelay", arg: "0–2" },
  { key: "direct.txdelay", arg: "0–2" },
  { key: "rxdelay", arg: "0–20" },
  { key: "multi.acks", values: ["0", "1"] },
  // Adverts and identity.
  { key: "advert.interval", arg: "minutes, up to 240; 0 is off" },
  { key: "flood.advert.interval", arg: "hours, 3–168; 0 is off" },
  { key: "name", arg: "name" },
  { key: "lat", arg: "degrees" },
  { key: "lon", arg: "degrees" },
  { key: "owner.info", arg: "text; | starts a new line" },
  { key: "public.key", set: false },
  { key: "role", set: false },
  { key: "prv.key", get: false, arg: "private key, hex; reboot to apply" },
  // Access.
  { key: "guest.password", arg: "password" },
  { key: "allow.read.only", values: ONOFF },
  // Power and board.
  { key: "adc.multiplier", arg: "e.g. 1.0; 0 is the board's own" },
  { key: "bootloader.ver", set: false },
  { key: "pwrmgt.support", set: false },
  { key: "pwrmgt.source", set: false },
  { key: "pwrmgt.bootreason", set: false },
  { key: "pwrmgt.bootmv", set: false },
  // Bridge builds.
  { key: "bridge.type", set: false },
  { key: "bridge.enabled", values: ONOFF },
  { key: "bridge.delay", arg: "0–10000 ms" },
  { key: "bridge.source", values: ["rx", "tx"] },
  { key: "bridge.baud", arg: "9600 and up" },
  { key: "bridge.channel", arg: "1–14" },
  { key: "bridge.secret", arg: "secret" },
  // MeshCoreTel.
  { key: "cad", values: ONOFF },
  { key: "extra.sf", arg: "up to 3 more SFs to listen on, e.g. 9 10" },
  { key: "radio.fem.rxgain", values: ONOFF },
  { key: "radio.fem.txgain", values: ONOFF },
  { key: "fan", values: ["auto", "on", "off", "timeout "] },
  { key: "web", values: ONOFF },
  { key: "web.stats", values: ONOFF, get: false },
  { key: "web.status", set: false },
  { key: "web.stats.status", set: false },
  { key: "wifi.ssid", arg: "network name" },
  { key: "wifi.pwd", arg: "password", get: false },
  { key: "wifi.powersaving", values: ["none", "min", "max"] },
  { key: "wifi.status", set: false },
  { key: "mqtt.status", values: ONOFF, get: false },
  { key: "mqtt.statuscfg", set: false },
  { key: "mqtt.client_version", set: false },
  { key: "mqtt.iata", arg: "airport code, e.g. OMS" },
  { key: "mqtt.owner", arg: "owner's public key, 64 hex" },
  { key: "mqtt.email", arg: "e-mail" },
  { key: "mqtt.packets", values: ONOFF },
  { key: "mqtt.raw", values: ONOFF },
  { key: "mqtt.tx", arg: "value" },
  { key: "mqtt.meshcoretel", values: ONOFF },
  { key: "mqtt.letsmesh-eu", values: ONOFF },
  { key: "mqtt.letsmesh-us", values: ONOFF },
];

const PLAIN: CliCommand[] = [
  { text: "ver" },
  { text: "board" },
  { text: "clock" },
  { text: "clock sync" },
  { text: "time ", arg: "epoch seconds; the clock only goes forward" },
  { text: "advert" },
  { text: "advert.zerohop" },
  { text: "neighbors" },
  { text: "discover.neighbors" },
  { text: "neighbor.remove ", arg: "public key, hex" },
  { text: "clear stats" },
  { text: "powersaving" },
  { text: "powersaving ", values: ONOFF },
  { text: "tempradio ", arg: "freq,bw,sf,cr,minutes — e.g. 869.525,250,11,5,10" },
  { text: "password ", arg: "new admin password" },
  { text: "setperm ", arg: "public key hex, then permissions 0–3" },
  { text: "log start" },
  { text: "log stop" },
  { text: "log erase" },
  { text: "sensor list" },
  { text: "sensor get ", arg: "key" },
  { text: "sensor set ", arg: "key value" },
  { text: "gps" },
  { text: "gps ", values: ["on", "off", "sync", "setloc", "advert"] },
  { text: "gps advert ", values: ["none", "share", "prefs"] },
  { text: "region" },
  { text: "region ", values: ["load", "save", "home", "default", "get ", "put ", "remove ", "allowf ", "denyf ", "list ", "def "] },
  { text: "region home ", arg: "region" },
  { text: "region default ", arg: "region, or <null>" },
  { text: "region get ", arg: "region" },
  { text: "region put ", arg: "region, then its parent" },
  { text: "region remove ", arg: "region" },
  { text: "region allowf ", arg: "region" },
  { text: "region denyf ", arg: "region" },
  { text: "region list ", values: ["allowed", "denied"] },
  { text: "region def ", arg: "region tree" },
  { text: "reboot" },
  { text: "clkreboot" },
  { text: "poweroff" },
  { text: "start ota" },
  // MeshCoreTel.
  { text: "memory" },
  { text: "eth.status" },
  { text: "send mqtt.status" },
  { text: "time.force ", arg: "epoch seconds" },
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
      return { chips, hint: at.arg ?? null };
    }
  }
  const t = typed.trim();
  const starts = COMMANDS.filter((c) => c.text.startsWith(typed) && c.text.trim() !== t);
  const inside = t.length >= 2 ? COMMANDS.filter((c) => !c.text.startsWith(typed) && c.text.includes(t)) : [];
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
