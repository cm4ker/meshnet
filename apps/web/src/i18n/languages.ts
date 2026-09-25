import { registerLanguages, SOURCE, type Entry, type Messages } from "./index.js";

type Words = Record<string, Entry>;

/**
 * Every folder beside `en` is a language, each file in it an area. Found at
 * build time, each loaded only when it is wanted. Kept apart from index.ts,
 * which the tests read outside Vite.
 */
const files = import.meta.glob<Words>(["./*/*.json", "!./en/*.json"], { import: "default" });

const found: Record<string, () => Promise<Messages>> = {};
const byLanguage = new Map<string, [string, () => Promise<Words>][]>();
for (const [path, read] of Object.entries(files)) {
  const [, code, area] = /^\.\/([^/]+)\/([^/]+)\.json$/.exec(path) ?? [];
  if (!code || !area || code === SOURCE) continue;
  byLanguage.set(code, [...(byLanguage.get(code) ?? []), [area, read]]);
}
for (const [code, areas] of byLanguage) {
  found[code] = async () => Object.fromEntries(await Promise.all(areas.map(async ([area, read]) => [area, await read()] as const)));
}

registerLanguages(found);
