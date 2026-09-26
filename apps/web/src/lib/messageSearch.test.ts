import { test } from "node:test";
import assert from "node:assert/strict";
import type { MessageRecord } from "@meshnet/meshcore";
import { findMessages, fold, matchRanges, searchTerm, snippet } from "./messageSearch.js";

function message(id: string, text: string, timestamp: number, conversation = "ch:0"): MessageRecord {
  return {
    id,
    conversation,
    direction: "in",
    text,
    sender: null,
    senderPrefix: null,
    timestamp,
    receivedAt: timestamp * 1000,
    snr: null,
    hops: null,
    txtType: 0,
    status: null,
    ackTag: null,
    roundTripMs: null,
    flood: null,
    attempt: 0,
    error: null,
    echoes: [],
    route: null,
    retryPlan: null,
  };
}

test("folding lowers case and reads ё as е, keeping every place", () => {
  assert.equal(fold("Ёлка у МОСТА"), "елка у моста");
  assert.equal(fold("İstanbul").length, "İstanbul".length);
  assert.equal(fold("👍 Ok"), "👍 ok");
});

test("a query of one letter is not searched; one emoji is", () => {
  assert.equal(searchTerm(" м "), null);
  assert.equal(searchTerm("мо"), "мо");
  assert.equal(searchTerm("👍"), "👍");
});

test("messages are found across chats whatever the case, the newest first", () => {
  const found = findMessages(
    [message("a", "завтра сбор у Моста", 100, "ch:2"), message("b", "привет", 200), message("c", "на мосту ловит", 300, "c:ab"), message("d", "МОСТ", 50)],
    "мост",
  );
  assert.deepEqual(
    found.map((m) => m.id),
    ["c", "a", "d"],
  );
});

test("ё in a query finds е in the text and back", () => {
  const all = [message("a", "ещё раз", 1), message("b", "еще раз", 2)];
  assert.deepEqual(findMessages(all, "ЕЩЁ").map((m) => m.id), ["b", "a"]);
  assert.deepEqual(findMessages(all, "еще").map((m) => m.id), ["b", "a"]);
});

test("every place the query stands is marked, none overlapping", () => {
  assert.deepEqual(matchRanges("Roof-2 и roof-3", "roof"), [
    [0, 4],
    [9, 13],
  ]);
  assert.deepEqual(matchRanges("аааа", "аа"), [
    [0, 2],
    [2, 4],
  ]);
  assert.deepEqual(matchRanges("мост", "м"), []);
});

test("a match far into a long message starts its line a word or two before it", () => {
  const text = "вчера вечером поставил на крышу новую антенну 868";
  const cut = snippet(text, "антенн");
  assert.ok(cut.startsWith("…"));
  assert.ok(cut.includes("антенну 868"));
  assert.ok(cut.length < text.length);
  assert.equal(snippet("новая антенна", "антенн"), "новая антенна");
});

test("a line is never cut inside an emoji", () => {
  const text = "😀".repeat(20) + " антенна";
  const cut = snippet(text, "антенна");
  const first = cut.charCodeAt(1);
  assert.ok(first < 0xdc00 || first > 0xdfff);
});
