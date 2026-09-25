import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { t } from "./index.js";

/*
 * Every language folder beside `en` is checked against it: the same files,
 * the same keys, the same placeholders, and a counted string counted in each.
 * A failure names what to translate.
 */

type Entry = string | Record<string, string>;
type Words = Record<string, Entry>;

const root = new URL("./", import.meta.url);
const read = (code: string, file: string): Words => JSON.parse(readFileSync(new URL(`${code}/${file}`, root), "utf8")) as Words;
const files = (code: string) => readdirSync(new URL(`${code}/`, root)).filter((f) => f.endsWith(".json")).sort();
const others = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== "en")
  .map((d) => d.name);

const placeholders = (entry: Entry): string[] => {
  const texts = typeof entry === "string" ? [entry] : Object.values(entry);
  return [...new Set(texts.flatMap((text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!)))].sort();
};

const CATEGORIES = new Set(["zero", "one", "two", "few", "many", "other"]);

test("English is well formed: a counted string has `other` and categories only", () => {
  for (const file of files("en")) {
    for (const [key, entry] of Object.entries(read("en", file))) {
      if (typeof entry === "string") continue;
      assert.ok("other" in entry, `en/${file} ${key} has no "other"`);
      for (const category of Object.keys(entry)) assert.ok(CATEGORIES.has(category), `en/${file} ${key}: "${category}" is not a plural category`);
    }
  }
});

for (const code of others) {
  test(`${code} has every file and key English has, and no others`, () => {
    assert.deepEqual(files(code), files("en"), `${code} has other files than en`);
    const missing: string[] = [];
    const extra: string[] = [];
    for (const file of files("en")) {
      const en = read("en", file);
      const words = read(code, file);
      for (const key of Object.keys(en)) if (!(key in words)) missing.push(`${file} ${key}`);
      for (const key of Object.keys(words)) if (!(key in en)) extra.push(`${file} ${key}`);
    }
    assert.deepEqual(missing, [], `${code} lacks these (English shows instead)`);
    assert.deepEqual(extra, [], `${code} has keys English no longer has`);
  });

  test(`${code} keeps English's placeholders, and counts what English counts`, () => {
    const rules = new Intl.PluralRules(code);
    const needed = new Set(rules.resolvedOptions().pluralCategories);
    for (const file of files("en")) {
      const en = read("en", file);
      const words = read(code, file);
      for (const [key, entry] of Object.entries(words)) {
        const source = en[key];
        if (source === undefined) continue;
        assert.deepEqual(placeholders(entry), placeholders(source), `${code}/${file} ${key}: placeholders differ from English`);
        assert.equal(typeof entry, typeof source, `${code}/${file} ${key}: English ${typeof source === "string" ? "does not count" : "counts"}`);
        if (typeof entry === "string") continue;
        for (const category of needed) assert.ok(category in entry, `${code}/${file} ${key}: no "${category}" form`);
        for (const category of Object.keys(entry)) assert.ok(needed.has(category as Intl.LDMLPluralRule), `${code}/${file} ${key}: ${code} has no "${category}"`);
      }
    }
  });
}

test("placeholders are filled, and one left unnamed stays as written", () => {
  assert.equal(t("common.ago", { time: "5 min" }), "5 min ago");
  assert.equal(t("common.ago"), "{time} ago");
  assert.equal(t("common.minutes", { count: 3 }), "3 min");
});
