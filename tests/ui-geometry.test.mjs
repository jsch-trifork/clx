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
test("family view fans never cross, stay on screen and start near the hub", async () => {
  const { fanPoint } = await import("../web/curve.js");
  const named = (n) =>
    Array.from({ length: n }, (_, i) => ({
      id: "f/" + i,
      key: "refinement-skill-" + i,
    }));
  for (const count of [1, 4, 7, 8, 13, 15, 35]) {
    const { points, edges } = buildSkillTree(named(count));
    for (const p of points)
      assert(
        Math.abs(p.y - 486) <= 300.01,
        "fan stays within the height budget",
      );
    for (const [a, b] of edges)
      if (a.join(",") === "680,486")
        assert(Math.hypot(b[0] - a[0], b[1] - a[1]) <= 240, "short trunk");
    const paths = edges.map(([a, b]) =>
      Array.from({ length: 41 }, (_, k) => fanPoint([680, 486], a, b, k / 40)),
    );
    const cross = (p, q, r, s) => {
      const d = (a, b, c) =>
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      return d(p, q, r) * d(p, q, s) < 0 && d(r, s, p) * d(r, s, q) < 0;
    };
    const same = (u, v) => u[0] === v[0] && u[1] === v[1];
    for (let i = 0; i < edges.length; i++)
      for (let j = i + 1; j < edges.length; j++) {
        if (edges[i].some((u) => edges[j].some((v) => same(u, v)))) continue;
        for (let k = 1; k < 41; k++)
          for (let l = 1; l < 41; l++)
            assert(
              !cross(
                paths[i][k - 1],
                paths[i][k],
                paths[j][l - 1],
                paths[j][l],
              ),
              "branches cross",
            );
      }
  }
});
