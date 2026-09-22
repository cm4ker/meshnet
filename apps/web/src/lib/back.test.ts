import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { canGoBack, goBack, openLayer, showSections } from "./back.js";
import { getNav, goSection, openConversation, openProfile, push, setStack } from "./nav.js";

beforeEach(() => {
  showSections(true);
  for (const s of ["chats", "mesh", "radio"] as const) setStack(s, [], { meshFocus: null });
  goSection("chats");
});

test("at the chat list with nothing open there is no step, and the app may leave", () => {
  assert.equal(canGoBack(), false);
  assert.equal(goBack(), false);
});

test("screens close one at a time, down to the chat list", () => {
  openConversation("c:abc");
  push({ kind: "profile", key: "abc" });
  push({ kind: "route", key: "abc" });
  assert.equal(goBack(), true);
  assert.deepEqual(getNav().stacks.chats.map((s) => s.kind), ["chat", "profile"]);
  assert.equal(goBack(), true);
  assert.equal(goBack(), true);
  assert.deepEqual(getNav().stacks.chats, []);
  assert.equal(goBack(), false);
});

test("a layer closes before the screen under it", () => {
  openConversation("c:abc");
  let closed = 0;
  const gone = openLayer(() => {
    closed++;
    gone();
  });
  assert.equal(goBack(), true);
  assert.equal(closed, 1);
  assert.equal(getNav().stacks.chats.length, 1);
  assert.equal(goBack(), true);
  assert.equal(getNav().stacks.chats.length, 0);
});

test("the newest layer goes first", () => {
  const order: string[] = [];
  const a = openLayer(() => (order.push("sheet"), a()));
  const b = openLayer(() => (order.push("dialog"), b()));
  goBack();
  goBack();
  assert.deepEqual(order, ["dialog", "sheet"]);
});

test("Mesh lets go of the picked node, then returns to Chats", () => {
  openProfile("abc", true);
  assert.equal(getNav().section, "mesh");
  assert.equal(goBack(), true);
  assert.deepEqual(getNav().stacks.mesh, []);
  assert.equal(getNav().meshFocus, "abc");
  assert.equal(goBack(), true);
  assert.equal(getNav().meshFocus, null);
  assert.equal(getNav().section, "mesh");
  assert.equal(goBack(), true);
  assert.equal(getNav().section, "chats");
  assert.equal(goBack(), false);
});

test("Radio returns to Chats", () => {
  goSection("radio");
  assert.equal(goBack(), true);
  assert.equal(getNav().section, "chats");
});

test("on the connect screen only its own layers take Back", () => {
  openConversation("c:abc");
  showSections(false);
  assert.equal(canGoBack(), false);
  assert.equal(goBack(), false);
  assert.equal(getNav().stacks.chats.length, 1);
  const gone = openLayer(() => gone());
  assert.equal(goBack(), true);
  assert.equal(goBack(), false);
});
