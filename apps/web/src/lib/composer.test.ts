import { test } from "node:test";
import assert from "node:assert/strict";
import { airtimeMs, blockEdges, costOf, geoText, headerBytes, mentionQuery, segments, splitParts, translit } from "./composer.js";
import { packLookalikes } from "./lookalikes.js";
import { utf8Length } from "./format.js";

const pack = (text: string) => packLookalikes(text, { on: true, near: false });
const PKIO = { spreadingFactor: 7, bandwidthHz: 62_500, codingRate: 7 };

test("time on air follows Semtech's formula with MeshCore's 32-symbol preamble at SF7", () => {
  // 2.048 ms symbols; 36.25 of preamble and 127 of payload for 56 bytes.
  assert.equal(Math.round(airtimeMs(56, PKIO) * 1000), Math.round((36.25 + 127) * 2.048 * 1000));
  // SF10 takes the 16-symbol preamble, and its 16.4 ms symbols the low data rate optimisation.
  const sf10 = { spreadingFactor: 10, bandwidthHz: 62_500, codingRate: 5 };
  assert.equal(Math.round(airtimeMs(56, sf10) * 1000), Math.round((20.25 + 83) * 16.384 * 1000));
});

test("a direct message is time, flags and text in 16-byte blocks, behind the header and its path", () => {
  const cost = costOf("Буду в 10:15 у входа, возьму запасной аккумулятор для T-Echo", { pack, prefix: "", header: headerBytes("direct", 2), radio: PKIO });
  assert.equal(cost.typed, 99);
  assert.equal(cost.used, 88);
  assert.equal(cost.budget, 160);
  assert.equal(cost.over, 0);
  assert.equal(cost.plain, 93);
  assert.equal(cost.blocks, 6);
  assert.equal(cost.packet, 8 + 96);
  // 36.25 symbols of preamble and 225 of payload, 2.048 ms each.
  assert.equal(cost.airMs?.toFixed(0), "535");
});

test("a channel's name and a reply's mention come out of the same 160 bytes", () => {
  const cost = costOf("5 из 5", { pack, prefix: "PKIO: @[Dima 🚲] ", header: headerBytes("channel"), radio: null });
  assert.equal(cost.prefix, 6 + 13);
  assert.equal(cost.budget, 160 - 19);
  assert.equal(cost.airMs, null);
});

test("block edges sit where the time, the flags and the text cross 16 bytes", () => {
  assert.deepEqual(blockEdges(), [11, 27, 43, 59, 75, 91, 107, 123, 139, 155]);
});

test("the runs under the field mark mentions and what lies past the budget", () => {
  const runs = segments("hi @[Bob] there", pack, 12);
  assert.deepEqual(
    runs.map((r) => [r.text, r.mention, r.over]),
    [
      ["hi ", false, false],
      ["@[Bob]", true, false],
      [" th", false, false],
      ["ere", false, true],
    ],
  );
  // A packed letter costs its packed byte.
  assert.equal(segments("аааа", pack, 3).find((r) => r.over)?.text, "а");
});

test("a mention is being typed after @ at the start or after a space, not inside a word", () => {
  assert.deepEqual(mentionQuery("hey @Di", 7), { start: 4, query: "Di" });
  assert.deepEqual(mentionQuery("@", 1), { start: 0, query: "" });
  assert.equal(mentionQuery("mail@host", 9), null);
  assert.equal(mentionQuery("@[Dima] ", 8), null);
});

test("a long text splits between words, each part within the budget with its mark", () => {
  const text = "Выходим в 10:15 от метро Приморская, идём вдоль залива до маяка, там ставим ретранслятор на крышу. Возьми запасной аккумулятор, антенну на 868 и стяжки";
  const parts = splitParts(pack(text), 160);
  assert.equal(parts.length, 2);
  assert.ok(parts[0]!.endsWith(" (1/2)") && parts[1]!.endsWith(" (2/2)"));
  for (const p of parts) assert.ok(utf8Length(p) <= 160);
  // A word longer than a part is cut where it must be.
  const cut = splitParts("x".repeat(300), 100);
  assert.equal(cut.length, 4);
  for (const p of cut) assert.ok(utf8Length(p) <= 100);
});

test("translit keeps capitals and drops the hard and soft signs", () => {
  assert.equal(translit("Щука съела Ёжика"), "Schuka sela Yozhika");
  assert.ok(utf8Length(translit("Привет, как слышно?")) < utf8Length("Привет, как слышно?"));
});

test("a position goes as a geo: link with four decimals", () => {
  assert.equal(geoText(59.938612, 30.314129), "geo:59.9386,30.3141");
  assert.equal(utf8Length(geoText(59.938612, 30.314129)), 19);
});
