// Each chain shares its fork with another chain: branches split at varied depths.
const chains = [
  [
    [680, 486],
    [784, 433],
    [819, 368],
    [850, 299],
    [880, 255],
  ],
  [
    [850, 299],
    [914, 278],
    [987, 216],
  ],
  [
    [914, 278],
    [1037, 240],
    [1069, 200],
    [1118, 181],
  ],
  [
    [1037, 240],
    [1097, 234],
    [1172, 259],
    [1239, 221],
    [1265, 182],
  ],
  [
    [784, 433],
    [848, 421],
    [892, 378],
    [940, 359],
    [1011, 369],
  ],
  [
    [1011, 369],
    [1041, 332],
    [1086, 319],
    [1125, 303],
  ],
  [
    [1011, 369],
    [1056, 398],
    [1109, 367],
    [1162, 369],
    [1213, 333],
    [1287, 304],
    [1377, 236],
    [1446, 163],
    [1526, 120],
    [1635, 91],
  ],
  [
    [1162, 369],
    [1204, 404],
    [1244, 415],
    [1314, 398],
    [1373, 406],
    [1469, 380],
    [1586, 411],
  ],
  [
    [680, 486],
    [801, 477],
    [882, 456],
    [938, 483],
    [997, 489],
    [1045, 476],
    [1118, 472],
    [1161, 496],
    [1201, 522],
  ],
  [
    [1201, 522],
    [1265, 556],
    [1297, 531],
    [1337, 519],
    [1390, 505],
    [1470, 535],
    [1553, 500],
    [1683, 457],
  ],
  [
    [1265, 556],
    [1320, 596],
    [1367, 625],
    [1424, 631],
    [1495, 624],
    [1597, 672],
  ],
  [
    [801, 477],
    [860, 536],
    [910, 560],
    [969, 580],
    [1050, 641],
  ],
  [
    [1050, 641],
    [1138, 658],
    [1186, 640],
  ],
  [
    [1050, 641],
    [1100, 702],
    [1153, 729],
    [1213, 754],
    [1244, 756],
  ],
  [
    [680, 486],
    [784, 542],
    [795, 582],
    [825, 612],
    [859, 650],
  ],
  [
    [859, 650],
    [908, 667],
    [947, 650],
  ],
  [
    [859, 650],
    [901, 700],
    [960, 728],
    [998, 720],
  ],
  [
    [1153, 729],
    [1294, 702],
    [1353, 731],
    [1414, 771],
    [1483, 803],
  ],
];
const skillCoords = [
  [850, 299],
  [987, 216],
  [1118, 181],
  [1097, 234],
  [1239, 221],
  [1265, 182],
  [1377, 236],
  [1446, 163],
  [1526, 120],
  [892, 378],
  [940, 359],
  [1041, 332],
  [1086, 319],
  [1125, 303],
  [1162, 369],
  [1244, 415],
  [1314, 398],
  [882, 456],
  [997, 489],
  [1118, 472],
  [1201, 522],
  [1337, 519],
  [1390, 505],
  [1470, 535],
  [1553, 500],
  [1683, 457],
  [860, 536],
  [910, 560],
  [969, 580],
  [1050, 641],
  [1138, 658],
  [1186, 640],
  [1153, 729],
  [960, 728],
  [1483, 803],
];

// Keep the reference's organic silhouette, but occupy only the space needed by
// this family's real skills. Unused routing vertices are not rendered as nodes.
export function buildSkillTree(skills) {
  const root = [680, 486];
  const key = (p) => p.join(",");
  const occupied = new Set(
    [...skillCoords]
      .sort(
        (a, b) =>
          a[0] -
          680 +
          Math.abs(a[1] - 486) * 0.45 -
          (b[0] - 680 + Math.abs(b[1] - 486) * 0.45),
      )
      .slice(0, skills.length)
      .map(key),
  );
  const coordinates = skillCoords.filter((p) => occupied.has(key(p)));
  while (coordinates.length < skills.length) {
    const i = coordinates.length - skillCoords.length;
    coordinates.push([1800 + Math.floor(i / 4) * 145, 260 + (i % 4) * 155]);
  }
  const points = skills.map((s, i) => ({
    x: coordinates[i][0],
    y: coordinates[i][1],
    s,
  }));
  const parents = new Map(
    chains.flatMap((chain) => chain.slice(1).map((p, i) => [key(p), chain[i]])),
  );
  const edges = coordinates.map((p, i) => {
    let parent = parents.get(key(p));
    if (i >= skillCoords.length) {
      const previous = coordinates.slice(0, i).filter((q) => q[0] < p[0]);
      parent = previous.sort(
        (a, b) =>
          Math.abs(a[1] - p[1]) +
          (p[0] - a[0]) * 0.3 -
          (Math.abs(b[1] - p[1]) + (p[0] - b[0]) * 0.3),
      )[0];
    } else {
      while (parent && key(parent) !== key(root) && !occupied.has(key(parent)))
        parent = parents.get(key(parent));
    }
    return [parent || root, p];
  });
  return { points, edges };
}
