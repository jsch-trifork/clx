import test from "node:test";
import assert from "node:assert/strict";
import { buildSkillTree } from "../web/geometry.js";
const make = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: "family/skill-" + i }));
for (const count of [0, 1, 7, 14, 15, 35, 50, 100])
  test(`${count} skills produce exactly ${count} actionable nodes and no empty branches`, () => {
    const { points, edges } = buildSkillTree(make(count));
    const actual = new Set(points.map((p) => [p.x, p.y].join(",")));
    assert.equal(points.length, count);
    assert.equal(actual.size, count);
    assert.equal(edges.length, count);
    const parents = new Map(edges.map(([a, b]) => [b.join(","), a.join(",")]));
    for (const [a, b] of edges) {
      assert(actual.has(b.join(",")));
      assert(a.join(",") === "680,486" || actual.has(a.join(",")));
      let key = b.join(","),
        steps = 0;
      while (key !== "680,486") {
        key = parents.get(key);
        assert(key);
        assert(++steps <= count, "no disconnected or cyclic routes");
      }
    }
  });
test("small families occupy a compact tree instead of the full 35-skill canvas", () => {
  const extent = (n) =>
    Math.max(...buildSkillTree(make(n)).points.map((p) => p.x));
  assert(extent(7) < 1100);
  assert(extent(7) < extent(14));
  assert(extent(14) < extent(35));
});
