import { test } from "node:test";
import assert from "node:assert/strict";
import { clusterPoints } from "./cluster.js";

test("points within the radius gather, the rest stand alone", () => {
  const groups = clusterPoints(
    [
      { item: "a", x: 0, y: 0 },
      { item: "b", x: 10, y: 0 },
      { item: "c", x: 200, y: 0 },
      { item: "d", x: 0, y: 30 },
    ],
    40,
  );
  assert.deepEqual(
    groups.map((g) => g.members),
    [["a", "b", "d"], ["c"]],
  );
  assert.equal(groups[0]!.x, 10 / 3);
  assert.equal(groups[0]!.y, 10);
});

test("nothing to cluster is no groups, and one point is a group of one", () => {
  assert.deepEqual(clusterPoints([], 40), []);
  assert.deepEqual(clusterPoints([{ item: 1, x: 5, y: 5 }], 40), [{ members: [1], x: 5, y: 5 }]);
});
