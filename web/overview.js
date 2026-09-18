// Hub positions are independent of selection so changing presets never moves groups.
export function familyLayout(count, width, height, skillCounts = []) {
  const scale = Math.max(width, 1280) / 1586;
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
  // A rounded perimeter leaves explicit lanes for top, bottom and side hubs.
  // Unlike a fixed ellipse, its ends cannot bunch up as more groups are added.
  const topCount = Math.ceil((count - 2) / 2);
  const bottomCount = count - 2 - topCount;
  const ry = 100;
  const rows = Math.max(
    1,
    Math.floor((height / 2 - ry - 20 - 55 - 155) / 27) + 1,
  );
  const slotWidth = Math.max(
    360,
    Math.ceil(Math.max(0, ...skillCounts) / rows) * 27 + 80,
  );
  const worldWidth = Math.max(width, 1400 + (topCount - 1) * slotWidth);
  const centerX = worldWidth / 2,
    centerY = height / 2;
  const points = [];
  const row = (n, side, reverse = false) => {
    for (let j = 0; j < n; j++) {
      const i = reverse ? n - 1 - j : j;
      const t = n === 1 ? 0.5 : i / (n - 1);
      points.push({
        x: 700 + t * (worldWidth - 1400),
        y: centerY + side * (ry + Math.sin(t * Math.PI) * 20),
        face: side < 0 ? "top" : "bottom",
      });
    }
  };
  row(topCount, -1);
  points.push({ x: worldWidth - 320, y: centerY, face: "right" });
  row(bottomCount, 1, true);
  points.push({ x: 320, y: centerY, face: "left" });
  const canonical = (x, y) => ({
    x: x / scale,
    y: (y - (height - 992 * scale) / 2) / scale,
  });
  const center = canonical(centerX, centerY);
  return {
    width: worldWidth,
    center: [center.x, center.y],
    positions: points.map((p) => ({ ...canonical(p.x, p.y), face: p.face })),
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
