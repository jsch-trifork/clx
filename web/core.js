const seed = (i) => (((Math.sin(i * 127.1 + 43.8) * 43758.5453) % 1) + 1) % 1;
const palette = ["#dcc09c", "#b6a1d7", "#87c6bd", "#df9cac", "#a0b9e9"];
// Stable seeds keep the cloud continuous across preset and family changes.
const particles = Array.from({ length: 480 }, (_, i) => ({
  phase: seed(i + 340) * Math.PI * 2,
  radius: Math.pow(seed(i + 780), 1.25),
  depth: seed(i + 180) * 2 - 1,
  speed: 0.065 + seed(i + 11) * 0.075,
  size: 0.6 + seed(i + 902) * 2.2,
  color: palette[i % palette.length],
  alpha: 0.3 + seed(i + 159) * 0.5,
}));
export function createCorePainter(canvas) {
  const ctx = canvas.getContext("2d");
  let width = 0,
    height = 0;
  const dot = (x, y, r, color, alpha) => {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  };
  return {
    resize(w, h, dpr) {
      width = w;
      height = h;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    },
    paint({ x, y, scale, time = 0, compact = false }) {
      ctx.clearRect(0, 0, width, height);
      const extent = (compact ? 110 : 133) * scale;
      if (x + extent < 0 || x - extent > width) return;
      const turn = time * 0.11;
      const projected = particles
        .map((p, i) => {
          const a = p.phase + time * p.speed * (i % 3 === 0 ? -1 : 1);
          const r = p.radius * extent;
          const px = Math.cos(a) * r;
          const pz = Math.sin(a) * r;
          const z = Math.sin(turn) * px + Math.cos(turn) * pz;
          const perspective = 1 + z / (extent * 4);
          return {
            p,
            i,
            z,
            x: x + (Math.cos(turn) * px - Math.sin(turn) * pz) * perspective,
            y:
              y +
              (Math.sin(a * 1.6 + p.depth * 3) * r * 0.58 +
                p.depth * extent * 0.23) *
                perspective,
            r: p.size * scale * perspective,
            alpha: p.alpha * (0.65 + (z / extent + 1) * 0.17),
          };
        })
        .sort((a, b) => a.z - b.z);
      // Short local filaments add depth without a solid core or an outer ring.
      ctx.lineWidth = 0.55 * scale;
      for (let i = 0; i < projected.length; i += 3) {
        const a = projected[i],
          b = projected[(i + 7) % projected.length];
        if (Math.hypot(a.x - b.x, a.y - b.y) < 23 * scale) {
          ctx.globalAlpha = 0.13;
          ctx.strokeStyle = a.p.color;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
      for (const q of projected) {
        if (q.i % 17 === 0) dot(q.x, q.y, q.r * 3, q.p.color, q.alpha * 0.06);
        if (q.i % 13 === 0) {
          ctx.globalAlpha = q.alpha * 0.24;
          ctx.strokeStyle = q.p.color;
          ctx.beginPath();
          ctx.moveTo(q.x - 5 * scale, q.y + 2 * scale);
          ctx.quadraticCurveTo(q.x - 2 * scale, q.y, q.x, q.y);
          ctx.stroke();
        }
        dot(q.x, q.y, q.r, q.p.color, q.alpha);
      }
      ctx.globalAlpha = 1;
    },
  };
}
