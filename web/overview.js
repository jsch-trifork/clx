import { layoutFan } from "./geometry.js";
// Hub positions are independent of selection so changing presets never moves groups.
export function familyLayout(count, width, height, skillCounts = []) {
  const old = [
    [450, 255],
    [1080, 270],
    [1230, 505],
    [1080, 745],
    [460, 745],
    [310, 505],
  ];
  if (count <= 6)
    return {
      width: Math.max(width, 1280),
      center: [793, 505],
      positions: old.slice(0, count).map(([x, y]) => ({ x, y })),
    };
  const radius = Math.max(280, count * 30);
  const size = (radius + 245) * 2;
  const center = [size / 2, size / 2];
  return {
    width: size,
    height: size,
    circular: true,
    center,
    positions: Array.from({ length: count }, (_, i) => {
      const angle = -Math.PI / 2 + (i * Math.PI * 2) / count;
      return {
        x: center[0] + Math.cos(angle) * radius,
        y: center[1] + Math.sin(angle) * radius,
        angle,
        face:
          Math.abs(Math.sin(angle)) > 0.7
            ? Math.sin(angle) < 0
              ? "top"
              : "bottom"
            : Math.cos(angle) < 0
              ? "left"
              : "right",
      };
    }),
  };
}

// The same ring fan as the family view. neighbours holds the skill counts of the
// families on the -angle and +angle sides; a bigger family takes more of the gap.
export function radialSkillTree(skills, hub, count, neighbours = []) {
  if (!skills.length) return { points: [], edges: [] };
  // reach estimates the outer ring; the rings themselves space out as needed.
  const inner = 80,
    reachOf = (n) => Math.min(190, 60 + n * 4),
    reach = reachOf(skills.length);
  // A ray tilted past half the hub spacing meets its neighbour's ray; keep that
  // meeting point beyond this fan's outer ring, sharing the gap by reach.
  const ring = Math.max(280, count * 30),
    half = Math.PI / count,
    first = (30 * Math.PI) / 180;
  const open = (neighbour = skills.length) => {
    const share = (2 * reach) / (reach + reachOf(neighbour));
    return Math.min(
      (70 * Math.PI) / 180,
      half +
        0.85 *
          Math.asin(
            Math.min(1, (share * ring * Math.sin(half)) / (inner + reach + 40)),
          ),
    );
  };
  const [before, after] = [open(neighbours[0]), open(neighbours[1])];
  const { points } = layoutFan(skills, {
    center: [hub.x, hub.y],
    inner,
    step: 34,
    gap: 16,
    range: (t) => [
      hub.angle - Math.min(before, first + (before - first) * t),
      hub.angle + Math.min(after, first + (after - first) * t),
    ],
  });
  const edges = points.map((p) => {
    const q = points[p.parent] || null;
    return {
      a: q ? [q.x, q.y] : [hub.x, hub.y],
      b: [p.x, p.y],
      p,
      q,
      fromHub: !q,
    };
  });
  points.forEach((p) => delete p.parent);
  return { points, edges };
}

export function familyColors(count) {
  const base = [
    "#b39be5",
    "#79c9c3",
    "#dda1b5",
    "#e7bd7f",
    "#92b9e3",
    "#c2ad76",
  ];
  if (count <= 6) return base.slice(0, count);
  // Use a coprime hue step: every color is unique and the last/first pair is
  // separated by the same hue distance as all the other neighboring families.
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  let step = Math.max(1, Math.floor(count * 0.382));
  while (gcd(step, count) !== 1) step++;

  return Array.from({ length: count }, (_, i) => {
    const hue = (265 + (i * step * 360) / count) % 360;
    const saturation = 0.48,
      lightness = 0.71;
    const a = saturation * Math.min(lightness, 1 - lightness);
    const channel = (n) => {
      const k = (n + hue / 30) % 12;
      return Math.round(
        255 * (lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))),
      )
        .toString(16)
        .padStart(2, "0");
    };
    return "#" + channel(0) + channel(8) + channel(4);
  });
}
