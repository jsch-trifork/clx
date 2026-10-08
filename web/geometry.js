// Skills grow as a fan of rings around their hub. Every edge joins two adjacent
// rings and siblings keep their angular order, so branches can never cross.
export const ROOT = [680, 486];

function trunkSizes(n) {
  const k = n <= 2 ? n : Math.min(5, Math.round(Math.sqrt(n)));
  const sizes = Array(k).fill(Math.floor(n / k));
  // Spare skills go to the middle trunks so the fan stays balanced.
  const order = [...sizes.keys()].sort(
    (a, b) => Math.abs(a - (k - 1) / 2) - Math.abs(b - (k - 1) / 2),
  );
  for (let i = 0; i < n % k; i++) sizes[order[i]]++;
  return sizes;
}

// Short remainders continue as a chain, except right after the hub, where a pair
// forks so small families branch out; longer remainders fork into two or three.
function split(rest, depth) {
  if (rest <= 1 || (rest === 2 && depth > 1)) return [rest];
  const parts = rest >= 12 ? 3 : 2;
  return Array.from(
    { length: parts },
    (_, i) => Math.floor(rest / parts) + (i < rest % parts ? 1 : 0),
  );
}

// Pre-order nodes; each has depth (1 = first ring), parent index (-1 = hub) and
// u in [0, 1], its position across the fan.
export function growTree(n) {
  const nodes = [];
  const grow = (size, depth, parent) => {
    const index = nodes.push({ depth, parent, children: [] }) - 1;
    if (size > 1)
      split(size - 1, depth).forEach((part) =>
        nodes[index].children.push(grow(part, depth + 1, index)),
      );
    return index;
  };
  const trunks = trunkSizes(n).map((size) => grow(size, 1, -1));
  const leaves = (i) =>
    nodes[i].children.length
      ? nodes[i].children.reduce((sum, c) => sum + leaves(c), 0)
      : 1;
  const assign = (list, u0, u1) => {
    const total = list.reduce((sum, i) => sum + leaves(i), 0);
    let at = u0;
    list.forEach((i) => {
      const next = at + ((u1 - u0) * leaves(i)) / total;
      nodes[i].u = (at + next) / 2;
      assign(nodes[i].children, at, next);
      at = next;
    });
  };
  assign(trunks, 0, 1);
  return nodes;
}

// range(t) gives a ring's [from, to] angles, t running 0 (first ring) to 1 (last).
// Rings sit at least step apart and far enough out that neighbours are gap apart.
export function layoutFan(skills, { center, inner, step, gap, range }) {
  const nodes = growTree(skills.length);
  const rings = Math.max(1, ...nodes.map((node) => node.depth));
  const ringRange = (depth) => range(rings > 1 ? (depth - 1) / (rings - 1) : 0);
  const radii = [];
  for (let depth = 1; depth <= rings; depth++) {
    const u = nodes
      .filter((node) => node.depth === depth)
      .map((node) => node.u)
      .sort((a, b) => a - b);
    const closest = Math.min(...u.slice(1).map((v, i) => v - u[i]));
    const [from, to] = ringRange(depth);
    const needed = Number.isFinite(closest)
      ? gap / (2 * Math.sin((Math.abs(to - from) * closest) / 2))
      : 0;
    const previous = radii.at(-1);
    radii.push(
      Math.max(previous === undefined ? inner : previous + step, needed),
    );
  }
  const points = nodes.map((node, i) => {
    const [from, to] = ringRange(node.depth);
    const angle = from + (to - from) * node.u,
      radius = radii[node.depth - 1];
    return {
      x: center[0] + Math.cos(angle) * radius,
      y: center[1] + Math.sin(angle) * radius,
      s: skills[i],
      parent: node.parent,
    };
  });
  return { points, rings };
}

// The family view reads left to right: one column per ring, labels in the gap.
// Rows keep their order between columns, so these branches cannot cross either.
export function buildSkillTree(skills) {
  const nodes = growTree(skills.length);
  const columns = Math.max(0, ...nodes.map((node) => node.depth));
  const longest = Math.max(0, ...skills.map((s) => (s.key || "").length));
  // The first column clears the family title; later ones fit the widest label.
  const first = 170,
    width = Math.min(320, 80 + longest * 7.5),
    row = 52;
  const heights = [];
  for (let depth = 1; depth <= columns; depth++) {
    const u = nodes
      .filter((node) => node.depth === depth)
      .map((node) => node.u)
      .sort((a, b) => a - b);
    const closest = Math.min(...u.slice(1).map((v, i) => v - u[i]));
    const needed = Number.isFinite(closest) ? row / closest : 0;
    heights.push(Math.min(760, Math.max(heights.at(-1) || 0, needed)));
  }
  const points = nodes.map((node, i) => ({
    x: ROOT[0] + first + (node.depth - 1) * width,
    y: ROOT[1] + (node.u - 0.5) * heights[node.depth - 1],
    s: skills[i],
  }));
  return {
    points,
    edges: nodes.map((node, i) => {
      const from = points[node.parent];
      return [from ? [from.x, from.y] : ROOT, [points[i].x, points[i].y]];
    }),
  };
}
