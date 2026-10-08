import test from "node:test";
import assert from "node:assert/strict";
import {
  familyLayout,
  familyColors,
  radialSkillTree,
} from "../web/overview.js";

test("large collections form a true evenly spaced circle around the core", () => {
  for (const count of [7, 8, 12, 18, 32])
    for (const width of [390, 1280, 1920]) {
      const layout = familyLayout(count, width, 860);
      assert.equal(layout.circular, true);
      assert.equal(layout.positions.length, count);
      const radii = layout.positions.map((p) =>
        Math.hypot(p.x - layout.center[0], p.y - layout.center[1]),
      );
      for (const r of radii) assert(Math.abs(r - radii[0]) < 0.001);
      for (let i = 1; i < count; i++)
        assert(
          Math.abs(
            layout.positions[i].angle -
              layout.positions[i - 1].angle -
              (Math.PI * 2) / count,
          ) < 0.001,
        );
      for (const p of layout.positions)
        assert(p.x > 0 && p.x < layout.width && p.y > 0 && p.y < layout.height);
    }
});
test("overview uses the real skill tree with shared forks and no decorative nodes", () => {
  for (const count of [0, 1, 7, 40, 80]) {
    const skills = Array.from({ length: count }, (_, i) => ({
      id: `skill-${i}`,
    }));
    const hub = familyLayout(12, 1280, 860).positions[3];
    const tree = radialSkillTree(skills, hub, 12);
    assert.equal(tree.points.length, count);
    assert.equal(tree.edges.length, count);
    const valid = new Set([
      `${hub.x},${hub.y}`,
      ...tree.points.map((p) => `${p.x},${p.y}`),
    ]);
    for (const e of tree.edges) {
      assert(valid.has(e.a.join(",")));
      assert(valid.has(e.b.join(",")));
    }
    if (count >= 40) {
      const forks = new Map();
      tree.edges
        .filter((e) => !e.fromHub)
        .forEach((e) =>
          forks.set(e.a.join(","), (forks.get(e.a.join(",")) || 0) + 1),
        );
      assert(
        [...forks.values()].some((n) => n > 1),
        "shared skill forks are preserved",
      );
    }
  }
});
test("small collections retain their established layout and palette", () => {
  assert.deepEqual(familyLayout(2, 1280, 860).positions, [
    { x: 450, y: 255 },
    { x: 1080, y: 270 },
  ]);
  assert.equal(familyLayout(0, 1280, 860).positions.length, 0);
  assert.deepEqual(familyColors(2), ["#b39be5", "#79c9c3"]);
});
test("large collection colors are unique and neighboring hues stay distinct, including the wraparound", () => {
  for (const count of [7, 8, 10, 12, 18, 32]) {
    const colors = familyColors(count);
    assert.equal(new Set(colors).size, count);
    const rgb = (s) =>
      s
        .slice(1)
        .match(/../g)
        .map((n) => parseInt(n, 16));
    for (let i = 0; i < count; i++) {
      const a = rgb(colors[i]),
        b = rgb(colors[(i + 1) % count]);
      assert(Math.hypot(...a.map((c, j) => c - b[j])) > 70);
    }
  }
});
test("overview fans never cross, stay apart from their neighbours and start near the hub", async () => {
  const { fanPoint } = await import("../web/curve.js");
  const sizes = [4, 7, 35, 14, 13, 13, 8, 15, 14, 7];
  const layout = familyLayout(sizes.length, 1280, 860);
  const fans = sizes.map((n, i) =>
    radialSkillTree(
      Array.from({ length: n }, (_, j) => ({ id: `f${i}-${j}` })),
      layout.positions[i],
      sizes.length,
      [
        sizes[(i + sizes.length - 1) % sizes.length],
        sizes[(i + 1) % sizes.length],
      ],
    ),
  );
  const segments = [];
  fans.forEach((fan, i) => {
    const hub = layout.positions[i];
    for (const e of fan.edges) {
      if (e.fromHub)
        assert(
          Math.hypot(e.b[0] - hub.x, e.b[1] - hub.y) <= 100,
          "short trunk",
        );
      const path = Array.from({ length: 41 }, (_, k) =>
        fanPoint([hub.x, hub.y], e.a, e.b, k / 40),
      );
      for (let k = 1; k < path.length; k++)
        segments.push({ edge: e, from: path[k - 1], to: path[k] });
    }
  });
  const cross = (p, q, r, s) => {
    const d = (a, b, c) =>
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    return d(p, q, r) * d(p, q, s) < 0 && d(r, s, p) * d(r, s, q) < 0;
  };
  const shares = (x, y) =>
    [x.a, x.b].some((u) =>
      [y.a, y.b].some((v) => u[0] === v[0] && u[1] === v[1]),
    );
  for (let i = 0; i < segments.length; i++)
    for (let j = i + 1; j < segments.length; j++) {
      const s = segments[i],
        t = segments[j];
      if (s.edge === t.edge || shares(s.edge, t.edge)) continue;
      assert(!cross(s.from, s.to, t.from, t.to), "branches cross");
    }
  const nodes = fans.flatMap((fan, i) => fan.points.map((p) => ({ ...p, i })));
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++)
      assert(
        Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y) >= 15.9,
        "nodes stack",
      );
});
