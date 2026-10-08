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
test("family view branches keep their row order between columns and never stack", () => {
  for (const count of [1, 4, 7, 8, 13, 15, 35]) {
    const { points, edges } = buildSkillTree(make(count));
    const pairs = new Map();
    for (const [a, b] of edges) {
      const key = a[0] + ">" + b[0];
      pairs.set(key, [...(pairs.get(key) || []), [a[1], b[1]]]);
    }
    for (const list of pairs.values()) {
      list.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
      for (let i = 1; i < list.length; i++)
        assert(list[i][1] >= list[i - 1][1], "edges between columns cross");
    }
    const columns = new Map();
    for (const p of points)
      columns.set(p.x, [...(columns.get(p.x) || []), p.y]);
    for (const column of columns.values()) {
      const ys = column.sort((a, b) => a - b);
      for (let i = 1; i < ys.length; i++) assert(ys[i] - ys[i - 1] >= 51.9);
    }
    for (const [a, b] of edges)
      if (a.join(",") === "680,486") assert(b[0] - a[0] <= 170);
  }
});
