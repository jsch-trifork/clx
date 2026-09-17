// Trim a cubic Bézier to the outside of both endpoint circles.
export function strokeBranch(
  ctx,
  start,
  end,
  color,
  width = 1,
  startRadius = 0,
  endRadius = 0,
) {
  const dx = (end[0] - start[0]) * 0.48;
  const controls = [
    start,
    [start[0] + dx, start[1]],
    [end[0] - dx * 0.5, end[1]],
    end,
  ];
  const at = (t) =>
    [0, 1].map(
      (k) =>
        (1 - t) ** 3 * controls[0][k] +
        3 * (1 - t) ** 2 * t * controls[1][k] +
        3 * (1 - t) * t * t * controls[2][k] +
        t ** 3 * controls[3][k],
    );
  const derivative = (t) =>
    [0, 1].map(
      (k) =>
        3 * (1 - t) ** 2 * (controls[1][k] - controls[0][k]) +
        6 * (1 - t) * t * (controls[2][k] - controls[1][k]) +
        3 * t * t * (controls[3][k] - controls[2][k]),
    );
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  if (distance(start, end) <= startRadius + endRadius) return;
  let low = 0,
    high = 1;
  for (let i = 0; i < 22; i++) {
    const mid = (low + high) / 2;
    if (distance(at(mid), start) < startRadius) low = mid;
    else high = mid;
  }
  const from = startRadius ? high : 0;
  low = 0;
  high = 1;
  for (let i = 0; i < 22; i++) {
    const mid = (low + high) / 2;
    if (distance(at(mid), end) > endRadius) low = mid;
    else high = mid;
  }
  const to = endRadius ? low : 1;
  if (from >= to) return;
  const a = at(from),
    b = at(to),
    da = derivative(from),
    db = derivative(to),
    span = (to - from) / 3;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(...a);
  ctx.bezierCurveTo(
    a[0] + da[0] * span,
    a[1] + da[1] * span,
    b[0] - db[0] * span,
    b[1] - db[1] * span,
    ...b,
  );
  ctx.stroke();
}
