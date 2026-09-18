import test from "node:test";
import assert from "node:assert/strict";
import { familyLayout, familyColors } from "../web/overview.js";

test("large collections reserve separate hub and label areas around all four sides", () => {
  for (const count of [7, 8, 10, 12, 18, 32])
    for (const width of [390, 1280, 1920])
      for (const height of [680, 860]) {
        const layout = familyLayout(count, width, height),
          scale = Math.max(width, 1280) / 1586;
        assert.equal(layout.positions.length, count);
        for (const face of ["top", "bottom", "left", "right"])
          assert(layout.positions.some((p) => p.face === face));
        for (const [i, a] of layout.positions.entries())
          for (const b of layout.positions.slice(i + 1))
            assert(
              Math.abs(a.x - b.x) * scale >= 330 ||
                Math.abs(a.y - b.y) * scale >= 190,
              `${count} skillsets at ${width}×${height} overlap`,
            );
        for (const p of layout.positions) {
          const x = p.x * scale,
            y = p.y * scale + (height - 992 * scale) / 2;
          assert(x >= 140 && x <= layout.width - 140);
          assert(y >= 150 && y <= height - 150);
        }
        assert(
          layout.width <= Math.max(width, 800 + count * 200),
          "map grew excessively",
        );
        assert.deepEqual(layout, familyLayout(count, width, height));
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
