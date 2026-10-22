const seed = (i) => (((Math.sin(i * 127.1 + 43.8) * 43758.5453) % 1) + 1) % 1;
// One orbit per family, inner to outer. Rings are HTML layers turned by CSS
// animations, so the compositor rotates them without the page redrawing.
const inner = 40,
  outer = 120;
export function createOrrery(el) {
  let built = "",
    placed = "",
    rings = [];
  const build = (colors) => {
    built = colors.join();
    el.textContent = "";
    const sun = document.createElement("span");
    sun.className = "orrery-sun";
    el.append(sun);
    rings = colors.map((color, i) => {
      const r =
          colors.length === 1
            ? (inner + outer) / 2
            : inner + ((outer - inner) * i) / (colors.length - 1),
        // Kepler-style periods: inner orbits come round faster.
        period = 30 * Math.pow(r / inner, 1.5),
        phase = seed(i + 400);
      const ring = document.createElement("span"),
        planet = document.createElement("span");
      ring.className = "orrery-ring";
      planet.className = "orrery-planet";
      ring.style.cssText =
        `--r:${r.toFixed(1)};--c:${color};--ring:${color}3d;` +
        `--t:${period.toFixed(1)}s;--delay:${(-phase * period).toFixed(1)}s;` +
        `--rest:${(phase * 360).toFixed(0)}deg`;
      ring.append(planet);
      el.append(ring);
      return { ring, planet, size: -1, current: null };
    });
  };
  return {
    // families: [{ color, total, on }]; current is the open family, or -1.
    update(families, current = -1) {
      const colors = families.map((f) => f.color);
      if (colors.join() !== built) build(colors);
      el.classList.toggle("focused", current >= 0);
      families.forEach((f, i) => {
        const o = rings[i],
          share = f.total ? f.on / f.total : 0,
          size = share ? 4 + share * 8 : 5;
        if (size !== o.size) {
          o.planet.style.setProperty("--size", size.toFixed(2));
          o.planet.classList.toggle("empty", !share);
          o.size = size;
        }
        if (o.current !== (i === current)) {
          o.current = i === current;
          o.ring.classList.toggle("current", o.current);
        }
      });
    },
    place({ x, y, scale, width, height }) {
      const place = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${scale.toFixed(3)})`;
      if (place !== placed) {
        // Glide between views, but not in from the corner on first placement.
        if (!placed) requestAnimationFrame(() => el.classList.add("placed"));
        el.style.transform = placed = place;
      }
      const reach = outer * scale + 12;
      el.classList.toggle(
        "offstage",
        x + reach < 0 ||
          x - reach > width ||
          y + reach < 0 ||
          y - reach > height,
      );
    },
  };
}
