import { buildSkillTree } from "./geometry.js";
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

// Preserve the topology of the expanded skill tree, including shared forks.
export function radialSkillTree(skills, hub, count) {
  const tree = buildSkillTree(skills);
  if (!tree.points.length) return { points: [], edges: [] };
  const extentX = Math.max(...tree.points.map((p) => p.x - 680));
  const extentY = Math.max(1, ...tree.points.map((p) => Math.abs(p.y - 486)));
  const sectorWidth =
    2 * Math.sin(Math.PI / count) * (Math.max(280, count * 30) + 110) * 0.76;
  const depth = Math.min(210, Math.max(130, 100 + skills.length * 2));
  const transform = ([x, y]) => {
    if (x === 680 && y === 486) return [hub.x, hub.y];
    const reach = 46 + ((x - 680) / extentX) * depth;
    const spread = (((y - 486) / extentY) * sectorWidth) / 2;
    return [
      hub.x + Math.cos(hub.angle) * reach - Math.sin(hub.angle) * spread,
      hub.y + Math.sin(hub.angle) * reach + Math.cos(hub.angle) * spread,
    ];
  };
  const points = tree.points.map((p) => {
    const [x, y] = transform([p.x, p.y]);
    return { ...p, x, y };
  });
  return {
    points,
    edges: tree.edges.map(([a, b], i) => ({
      a: transform(a),
      b: transform(b),
      p: points[i],
      fromHub: a[0] === 680 && a[1] === 486,
    })),
  };
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
