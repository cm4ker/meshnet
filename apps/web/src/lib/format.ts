/** Small formatters shared by the views. */

/*
 * `toLocale*String` with options builds a new `Intl.DateTimeFormat` on every call, a tenth of
 * a millisecond or more on a phone. A list of nodes or a long chat asks for hundreds of dates
 * on each render, so the formats are made once.
 */
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const DAY_OF_YEAR = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

export function timeOfDay(unixSeconds: number): string {
  return CLOCK.format(unixSeconds * 1000);
}

export function dayLabel(unixSeconds: number, now = Date.now()): string {
  const date = new Date(unixSeconds * 1000);
  const today = new Date(now);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(date, today)) return "Today";
  const yesterday = new Date(now - 86_400_000);
  if (sameDay(date, yesterday)) return "Yesterday";
  return (date.getFullYear() === today.getFullYear() ? DAY : DAY_OF_YEAR).format(date);
}

/** "just now", "5 min", "3 h", "2 d", or a date for anything older. */
export function ago(ms: number | null, now = Date.now()): string {
  if (!ms) return "never";
  const delta = Math.max(0, now - ms);
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} min`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} h`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} d`;
  return DAY.format(ms);
}

export function frequency(khz: number): string {
  return `${(khz / 1000).toFixed(3)} MHz`;
}

export function bandwidth(hz: number): string {
  return `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 2)} kHz`;
}

export function shortKey(hex: string, n = 6): string {
  return hex.slice(0, n * 2);
}

export function initials(name: string): string {
  // Letters and digits only: "Bob (bike)" is BB, not "B(".
  const words = name
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

const graphemes = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/**
 * The emoji a name ends with, "Fox 🦊" gives "🦊", for the node's circle as
 * the official app draws it; null when it ends otherwise. A symbol drawn as
 * text by default, such as "©", does not count unless it asks to be an emoji.
 */
export function trailingEmoji(name: string): string | null {
  const text = name.trimEnd();
  if (!text || !graphemes) return null;
  let last = "";
  for (const { segment } of graphemes.segment(text)) last = segment;
  if (/\p{Regional_Indicator}/u.test(last)) return last;
  return /\p{Extended_Pictographic}/u.test(last) && (/\p{Emoji_Presentation}/u.test(last) || last.includes("\uFE0F")) ? last : null;
}

/** A stable hue from a name, for the swatch behind its initials. */
export function hue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function battery(mv: number): string {
  return `${(mv / 1000).toFixed(2)} V`;
}

/** A LiPo's charge from its voltage; rough, and honest about it. */
export function batteryPercent(mv: number): number {
  const clamped = Math.max(3300, Math.min(4200, mv));
  return Math.round(((clamped - 3300) / 900) * 100);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** "just now", "12 min ago", "3 h ago": `ago` as it reads after a verb. */
export function agoPhrase(ms: number | null, now = Date.now()): string {
  const text = ago(ms, now);
  return text === "just now" || text === "never" || now - (ms ?? 0) >= 7 * 86_400_000 ? text : `${text} ago`;
}
