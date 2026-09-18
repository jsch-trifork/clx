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
