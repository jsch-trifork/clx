import { buildSkillTree } from "./geometry.js";
import { strokeBranch } from "./curve.js";
import { createCorePainter } from "./core.js";
(() => {
  let DATA = {
      families: [],
      presets: [],
      models: [],
      mcpNames: [],
      otherPlugins: [],
    },
    revision = "",
    draft = null,
    originalName = null,
    busy = false;
  let models = [];
  let token = location.hash.slice(1) || sessionStorage.getItem("clx-session");
  if (token) {
    sessionStorage.setItem("clx-session", token);
    history.replaceState(null, "", location.pathname);
  }
  const root = document.getElementById("clx-atlas"),
    canvas = root.querySelector("canvas"),
    ctx = canvas.getContext("2d"),
    layer = root.querySelector(".nodes"),
    panel = root.querySelector(".inspector"),
    menu = root.querySelector(".menu"),
    notice = root.querySelector(".notice");
  const motionCanvas = root.querySelector(".core-motion");
  const corePainter = createCorePainter(motionCanvas);
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let baseEdges = [];
  let namingFirstPreset = false;
  let editMode = false,
    labelsRight = 0,
    motionFrame = 0,
    lastMotion = 0;
  const nodeRadius = () => 9;
  const overviewNodeRadius = () => (w < 600 ? 5 : 6);
  let colors = [];
  let family = 0,
    preset = 0,
    pan = 0,
    w = 0,
    h = 0,
    scale = 1,
    selected = null,
    points = [],
    edges = [],
    buttons = [],
    dirty = false,
    undo = null,
    drag = null,
    moved = false;

  const esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const fam = () => DATA.families[family],
    isOn = (s) => models[preset].has(s.id),
    short = (s) => s.key;
  function layoutLabels() {
    if (!w || !points.length) return;
    ctx.font = "13px Inter, system-ui";
    const offset = w < 600 ? -205 : 0;
    points.forEach((p) => {
      p.x = p.anchor[0];
      p.y = p.anchor[1];
    });
    const nodeBox = (p) => ({
      x: p.x * scale + offset - 22,
      y: Y(p.y) - 22,
      width: 44,
      height: 44,
    });
    const fixed = [
      {
        x: 680 * scale + offset - 130,
        y: Y(486) - 135,
        width: 260,
        height: 82,
      },
      { x: 680 * scale + offset - 60, y: Y(486) - 60, width: 120, height: 120 },
      {
        x: 414 * scale + offset - 110,
        y: Y(515) - 110,
        width: 220,
        height: 220,
      },
    ];
    const labels = [];
    const overlap = (a, b) =>
      a.x < b.x + b.width + 5 &&
      a.x + a.width + 5 > b.x &&
      a.y < b.y + b.height + 5 &&
      a.y + a.height + 5 > b.y;
    labelsRight = 0;
    [...points]
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .forEach((p) => {
        const width = Math.ceil(ctx.measureText(p.s.key).width) + 14,
          height = 24;
        const bx = p.anchor[0] * scale + offset,
          by = Y(p.anchor[1]);
        const anchors = [
          [20, -12],
          [-width / 2, -39],
          [-width / 2, 20],
          [-width - 20, -12],
          [20, -39],
          [20, 20],
          [-width - 20, -39],
          [-width - 20, 20],
        ];
        const obstacles = [
          ...fixed,
          ...points.filter((q) => q !== p).map(nodeBox),
          ...labels,
        ];
        let result;
        for (let shiftX = 0; shiftX <= 1600 && !result; shiftX += 65) {
          for (const shiftY of [
            0, -32, 32, -64, 64, -96, 96, -128, 128, -160, 160, -192, 192,
          ]) {
            const x = bx + shiftX,
              y = by + shiftY;
            if (y < 155 || y > h - 125) continue;
            const circle = { x: x - 22, y: y - 22, width: 44, height: 44 };
            if (obstacles.some((b) => overlap(circle, b))) continue;
            for (const [dx, dy] of anchors) {
              const box = { x: x + dx, y: y + dy, width, height };
              if (
                box.y < 125 ||
                box.y + height > h - 100 ||
                obstacles.some((b) => overlap(box, b))
              )
                continue;
              result = { x, y, dx, dy, box };
              break;
            }
            if (result) break;
          }
        }
        if (!result) {
          const x = Math.max(bx, labelsRight + 45),
            y = Math.max(155, Math.min(h - 125, by));
          result = {
            x,
            y,
            dx: 20,
            dy: -12,
            box: { x: x + 20, y: y - 12, width, height },
          };
        }
        p.x = (result.x - offset) / scale;
        p.y = (result.y - (h - 992 * scale) / 2) / scale;
        p.label = { dx: result.dx, dy: result.dy, width, height };
        labels.push(result.box);
        labelsRight = Math.max(labelsRight, result.box.x + width);
      });
    const relocated = new Map(
      points.map((p) => [p.anchor.join(","), [p.x, p.y]]),
    );
    edges = baseEdges.map(([a, b]) => [
      relocated.get(a.join(",")) || a,
      relocated.get(b.join(",")) || b,
    ]);
  }
  function toggleSkill(s, f = fam()) {
    const selection = draft.record.skillPlugins[f.id] || { mode: "off" };
    const keys = new Set(
      selection.mode === "full"
        ? f.skills.map((v) => v.key)
        : selection.skills || [],
    );
    const removed = keys.has(s.key);
    removed ? keys.delete(s.key) : keys.add(s.key);
    draft.record.skillPlugins[f.id] = {
      mode: keys.size ? "subset" : "off",
      ...(keys.size ? { skills: [...keys] } : {}),
    };
    changed();
    acknowledgeSkill(s.id);
    announce(
      selection.mode === "full"
        ? f.name + " is now skills only; plugin hooks and agents are excluded."
        : s.key + (removed ? " removed from preset" : " added to preset"),
    );
  }
  function skillChange(skill) {
    const saved = DATA.presets.find((p) => p.name === originalName);
    const was = saved ? selectedIds(saved.record).has(skill.id) : false;
    const now = selectedIds(draft.record).has(skill.id);
    return was === now ? "" : now ? "added" : "removed";
  }
  function markChange(button, skill) {
    const change = skillChange(skill);
    button.dataset.change = change;
    button.title = skill.key + (change ? " — " + change + " (unsaved)" : "");
  }
  function cancelEdits() {
    namingFirstPreset = false;
    if (busy) return;
    usePreset();
    notice.textContent = "";
    setEditMode(false);
    refresh();
    announce("Edits discarded. Saved preset restored.");
  }
  function setEditMode(value) {
    if (!value && dirty) {
      leaveDraft(() => {
        usePreset();
        setEditMode(false);
        refresh();
      });
      return;
    }
    editMode = value;
    root.classList.toggle("editing", value);
    root
      .querySelector("[data-mode-view]")
      .setAttribute("aria-pressed", String(!value));
    root
      .querySelector("[data-mode-edit]")
      .setAttribute("aria-pressed", String(value));
    panel.hidden = true;
    menu.hidden = true;
    selected = null;
    renderChrome();
    draw();
    root.querySelector("#clx-announcement").textContent = value
      ? "Edit mode: click any skill to add or remove it. Save when finished."
      : "View mode: click a skill to read its details.";
  }
  const motionEase = "cubic-bezier(0.16, 1, 0.3, 1)";
  function animateElement(element, frames, duration = 260, delay = 0) {
    if (!element || reducedMotion.matches || document.hidden) return;
    element.getAnimations().forEach((a) => a.cancel());
    return element.animate(frames, {
      duration,
      delay,
      easing: motionEase,
      fill: "backwards",
    });
  }
  function openBranches() {
    if (reducedMotion.matches) return;
    animateElement(canvas, [{ opacity: 0.65 }, { opacity: 1 }], 380);
    const hub = overview ? [OX(793), OY(505)] : [X(680), Y(486)];
    layer.querySelectorAll(".node, .family").forEach((b, i) => {
      const x = parseFloat(b.style.left),
        y = parseFloat(b.style.top);
      const dx = (hub[0] - x) * 0.07,
        dy = (hub[1] - y) * 0.07;
      animateElement(
        b,
        [
          { transform: `translate(${dx}px, ${dy}px) scale(.88)`, opacity: 0.2 },
          { transform: "translate(0,0) scale(1)", opacity: 1 },
        ],
        420,
        Math.min(i * 8, 140),
      );
    });
  }
  function acknowledgeSkill(id) {
    const b = [...layer.querySelectorAll("[data-skill]")].find(
      (b) => b.dataset.skill === id,
    );
    animateElement(
      b,
      [
        { boxShadow: "0 0 0 0 #bca8de99", transform: "scale(.94)" },
        { boxShadow: "0 0 0 9px #bca8de00", transform: "scale(1)" },
      ],
      320,
    );
  }
  let corePose = null;
  function paintCore(now = performance.now()) {
    if (!w || !draft) return;
    const target = {
      x: overview ? OX(793) : X(414),
      y: overview ? OY(505) : Y(515),
      scale: overview ? (Math.max(0.8, w / 1586) * 110) / 133 : scale,
    };
    if (!corePose || reducedMotion.matches) corePose = { ...target, now };
    const blend =
      1 - Math.exp(-Math.min(100, Math.max(0, now - corePose.now)) / 90);
    for (const key of ["x", "y", "scale"])
      corePose[key] += (target[key] - corePose[key]) * blend;
    corePose.now = now;
    corePainter.paint({
      ...corePose,
      time: reducedMotion.matches ? 0 : now / 1000,
    });
  }

  function startMotion() {
    cancelAnimationFrame(motionFrame);
    motionFrame = 0;
    paintCore();
    if (reducedMotion.matches || document.hidden) return;
    const tick = (now) => {
      if (now - lastMotion > 33) {
        paintCore(now);
        lastMotion = now;
      }
      motionFrame = requestAnimationFrame(tick);
    };
    motionFrame = requestAnimationFrame(tick);
  }

  function build() {
    if (overview) {
      buildOverview();
      return;
    }
    const skills = [...fam().skills];
    ({ points, edges } = buildSkillTree(skills));
    baseEdges = edges;
    points.forEach((p) => (p.anchor = [p.x, p.y]));
    layoutLabels();
    layer.innerHTML = "";
    buttons = [];
    points.forEach((p, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "node" + ([2, 14, 20, 29].includes(i) ? " named" : "");
      b.dataset.skill = p.s.id;
      b.onfocus = () => revealOverview(p.x);
      b.setAttribute("aria-label", p.s.key);
      b.innerHTML = "<span>" + esc(short(p.s)) + "</span>";
      b.onclick = () => {
        if (!moved) {
          if (editMode) toggleSkill(p.s);
          else inspect(p.s);
        }
      };
      b.onfocus = () => {
        const left = X(p.x) + Math.min(-22, p.label.dx),
          right = X(p.x) + Math.max(22, p.label.dx + p.label.width);
        if (left < 24 || right > w - 24) {
          pan = Math.max(
            0,
            Math.min(
              maxPan(),
              pan + (right > w - 24 ? right - w + 24 : left - 24),
            ),
          );
          draw();
        }
      };
      layer.append(b);
      buttons.push(b);
    });
    const main = document.createElement("button");
    main.type = "button";
    main.className = "family";
    main.innerHTML =
      '<span class="caption"><b>' +
      esc(fam().name) +
      "</b><small>" +
      fam().skills.length +
      ' skills · one family</small></span><span class="glyph"><i data-lucide="hexagon"></i></span>';
    main.setAttribute("aria-label", fam().name + " family options");
    main.onclick = familyOptions;
    layer.append(main);
    main.dataset.main = "1";
    const sat = document.createElement("button");
    sat.type = "button";
    sat.className = "family satellite";
    sat.innerHTML =
      '<span class="glyph"><i data-lucide="triangle"></i></span><span class="caption"><b>' +
      esc(
        DATA.families[family === 0 ? Math.min(1, DATA.families.length - 1) : 0]
          ?.name || "",
      ) +
      "</b><small>" +
      "Explore family" +
      "</small></span>";
    sat.onclick = () =>
      changeFamily(family === 0 ? Math.min(1, DATA.families.length - 1) : 0);
    sat.dataset.sat = "1";
    layer.append(sat);
    if (globalThis.lucide) lucide.createIcons();
    root.querySelector(".trail").textContent =
      "/   " + fam().name.toUpperCase();
    draw();
  }
  function X(x) {
    return x * scale - pan + (w < 600 ? -205 : 0);
  }
  function Y(y) {
    return y * scale + (h - 992 * scale) / 2;
  }
  function maxPan() {
    if (overview) return Math.max(0, 1280 - w);
    const last = Math.max(680, ...points.map((p) => p.x));
    return Math.max(
      0,
      Math.max(last * scale + (w < 600 ? -205 : 0) + 32, labelsRight + 24) - w,
    );
  }
  function dot(x, y, r, color, alpha = 1) {
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  function line(a, b, color, width = 1, startRadius = 0, endRadius = 0) {
    strokeBranch(
      ctx,
      [X(a[0]), Y(a[1])],
      [X(b[0]), Y(b[1])],
      color,
      width,
      startRadius,
      endRadius,
    );
  }
  function ring(x, y, r, color, width = 1) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }
  function rnd(i) {
    return (((Math.sin(i * 127.1 + 43.8) * 43758.5453) % 1) + 1) % 1;
  }
  function draw() {
    if (!w || !draft) return;
    if (!panel.hidden && panel.classList.contains("skill-details"))
      locatePanel();
    if (overview) {
      drawOverview();
      return;
    }
    ctx.clearRect(0, 0, w, h);
    const glow = ctx.createRadialGradient(
      w * 0.44,
      h * 0.5,
      0,
      w * 0.44,
      h * 0.5,
      w * 0.72,
    );
    glow.addColorStop(0, "#242239");
    glow.addColorStop(1, "#151525");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
    const grid = 70 * scale;
    ctx.lineWidth = 0.6;
    ctx.strokeStyle = "#77718a0e";
    ctx.beginPath();
    for (let x = -pan % grid; x < w; x += grid) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    for (let y = 18; y < h; y += grid) {
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();
    for (let i = 0; i < 45; i++)
      dot(
        rnd(i + 3) * w,
        rnd(i + 71) * h,
        rnd(i + 10) * 1.2,
        "#b6adce",
        0.12 + rnd(i + 20) * 0.1,
      );
    // The quiet routes are ownership paths, never skill prerequisites.
    const activeRoutes = new Set(
      points.filter((p) => isOn(p.s)).map((p) => p.x + "," + p.y),
    );
    for (let pass = 0; pass < 20; pass++)
      edges.forEach((e) => {
        if (activeRoutes.has(e[1].join(","))) activeRoutes.add(e[0].join(","));
      });
    const routeRadii = new Map(
      points.map((p) => [[p.x, p.y].join(","), nodeRadius() + 2]),
    );
    routeRadii.set("680,486", 54 * scale);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    points.forEach((p) => {
      const x = X(p.x),
        y = Y(p.y),
        r = nodeRadius() + 1;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    });
    ctx.clip("evenodd");
    edges.forEach((e) =>
      line(
        e[0],
        e[1],
        activeRoutes.has(e[1].join(",")) ? colors[family] + "65" : "#88839840",
        1,
        routeRadii.get(e[0].join(",")) || 0,
        routeRadii.get(e[1].join(",")) || 0,
      ),
    );
    ctx.restore();
    points.forEach((p, i) => {
      const on = isOn(p.s),
        active = selected === p.s.id,
        x = X(p.x),
        y = Y(p.y),
        r = nodeRadius();
      let c = on ? colors[family] : "#e0ddd6";
      if (active) c = "#f4c889";
      if (on) {
        const g = ctx.createRadialGradient(x, y, 0, x, y, 20 * scale);
        g.addColorStop(0, c + "38");
        g.addColorStop(1, c + "00");
        ctx.fillStyle = g;
        ctx.fillRect(x - 20 * scale, y - 20 * scale, 40 * scale, 40 * scale);
        if (i % 3 === 0 || active) ring(x, y, r + 6 * scale, c + "aa", 0.8);
      }
      if (on) dot(x, y, r, c);
      else ring(x, y, r, active ? "#f4c889" : "#d3cdd3b0", 1);
      const b = buttons[i];
      markChange(b, p.s);
      b.style.left = x + "px";
      b.style.top = y + "px";
      const label = b.querySelector("span");
      label.style.left = 22 + p.label.dx + "px";
      label.style.top = 22 + p.label.dy + "px";
      if (editMode) {
        b.setAttribute("aria-pressed", String(on));
        b.removeAttribute("aria-haspopup");
      } else {
        b.removeAttribute("aria-pressed");
        b.setAttribute("aria-haspopup", "dialog");
      }
      b.classList.toggle("selected", active);
      b.setAttribute(
        "aria-label",
        p.s.key + (on ? ", selected in preset" : ", not selected"),
      );
    });
    const ax = X(680),
      ay = Y(486);
    ctx.fillStyle = "#1c2030";
    ctx.beginPath();
    ctx.arc(ax, ay, 60 * scale, 0, 7);
    ctx.fill();
    ring(ax, ay, 64 * scale, colors[family] + "25");
    ring(ax, ay, 51 * scale, colors[family], 1.3);
    const main = layer.querySelector("[data-main]");
    main.style.left = ax + "px";
    main.style.top = ay + "px";
    main.style.width = 104 * scale + "px";
    main.style.height = 104 * scale + "px";
    main.style.margin = -52 * scale + "px";
    main.style.color = colors[family];
    const sx = X(248),
      sy = Y(267);
    ring(sx, sy, 44 * scale, "#a58ac122");
    ring(sx, sy, 34 * scale, "#b499e0", 1.2);
    const sat = layer.querySelector("[data-sat]");
    sat.style.visibility =
      sx < 35 || DATA.families.length < 2 ? "hidden" : "visible";
    sat.style.left = sx + "px";
    sat.style.top = sy + "px";
    sat.style.width = 70 * scale + "px";
    sat.style.height = 70 * scale + "px";
    sat.style.margin = -35 * scale + "px";
    const ox = X(414),
      oy = Y(515);
    ctx.setLineDash([1.5, 7]);
    line([295, 310], [385, 477], "#ab96d399");
    line([470, 528], [618, 489], "#e4bf7799");
    ctx.setLineDash([]);
    paintCore();
    const fade = ctx.createLinearGradient(w - 48, 0, w, 0);
    fade.addColorStop(0, "#19192c00");
    fade.addColorStop(1, "#19192cf4");
    ctx.fillStyle = fade;
    ctx.fillRect(w - 48, 0, 48, h);
    root
      .querySelectorAll("[data-preset]")
      .forEach((b) =>
        b.setAttribute("aria-pressed", Number(b.dataset.preset) === preset),
      );
    root.querySelector(".session").textContent =
      models[preset].size +
      " skills selected" +
      (dirty ? " · unsaved changes" : "");
    root.querySelector("[data-action=back]").disabled = pan <= 0;
    root.querySelector("[data-action=next]").disabled = pan >= maxPan();
  }
  function resize() {
    w = root.clientWidth;
    h = root.clientHeight;
    scale = w < 600 ? 0.55 : w / 1586;
    canvas.width = w * devicePixelRatio;
    canvas.height = h * devicePixelRatio;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    corePainter.resize(w, h, devicePixelRatio);
    layoutLabels();
    pan = Math.min(pan, maxPan());
    draw();
  }
  function close() {
    panel.hidden = true;
    selected = null;
    draw();
  }
  function locatePanel() {
    if (!panel.classList.contains("skill-details")) {
      panel.style.width = "";
      panel.style.maxHeight = "";
      panel.style.left = Math.max(16, Math.min(w - 376, w * 0.59)) + "px";
      panel.style.top = (w < 600 ? 155 : 135) + "px";
      return;
    }
    panel.style.width = Math.min(360, w - 32) + "px";
    panel.style.maxHeight =
      (w < 600 ? Math.min(h * 0.55, h - 160) : h - 200) + "px";
    const pw = panel.offsetWidth,
      ph = panel.offsetHeight;
    if (w < 600) {
      panel.style.left = "16px";
      panel.style.top = Math.max(140, h - ph - 16) + "px";
      panel.style.transformOrigin = "50% 100%";
      panel.dataset.placement = "bottom";
      return;
    }
    const point = points.find((p) => p.s.id === selected);
    if (!point) return;
    const x = X(point.x),
      y = Y(point.y),
      gap = 28;
    const candidates = [
      { side: "right", left: x + gap, top: y - ph / 2 },
      { side: "left", left: x - gap - pw, top: y - ph / 2 },
      { side: "above", left: x - pw / 2, top: y - gap - ph },
      { side: "below", left: x - pw / 2, top: y + gap },
    ];
    const fits = (p) =>
      p.left >= 16 &&
      p.left + pw <= w - 16 &&
      p.top >= 96 &&
      p.top + ph <= h - 96;
    const best =
      candidates.find(fits) ||
      candidates.find((p) => p.left >= 16 && p.left + pw <= w - 16) ||
      candidates[2];
    const left = Math.max(16, Math.min(w - pw - 16, best.left));
    const top = Math.max(96, Math.min(h - ph - 96, best.top));
    panel.style.left = left + "px";
    panel.style.top = top + "px";
    panel.style.transformOrigin = `${Math.max(0, Math.min(pw, x - left))}px ${Math.max(0, Math.min(ph, y - top))}px`;
    panel.dataset.placement = best.side;
  }
  function inspect(s) {
    menu.hidden = true;
    selected = s.id;
    panel.classList.remove("preset-editor");
    panel.classList.add("skill-details");
    panel.hidden = false;
    const mode = draft.record.skillPlugins?.[fam().id]?.mode || "off";
    panel.innerHTML =
      '<button class="close" aria-label="Close details">×</button><div class="eyebrow">' +
      esc(fam().name) +
      " / skill</div><h3>" +
      esc(s.key) +
      "</h3><p>" +
      esc(s.description || "No description provided.") +
      "</p>" +
      (!s.available
        ? '<p class="error">Skill file unavailable. Refresh your catalog before launching.</p>'
        : "") +
      "<p>" +
      esc(draft.name) +
      " · " +
      (isOn(s) ? "Selected" : "Not selected") +
      "</p>" +
      (mode === "full"
        ? "<p>This family loads as a whole plugin. Removing a skill switches it to skills only, without the plugin’s hooks and agents.</p>"
        : "") +
      '<div class="row"><button class="control primary" data-edit-skills>Edit skills on the map</button></div>';
    panel.querySelector(".close").onclick = () => {
      close();
      buttons.find((b) => b.dataset.skill === s.id)?.focus();
    };
    panel.querySelector("[data-edit-skills]").onclick = () => setEditMode(true);
    draw();
    locatePanel();
    animateElement(
      panel,
      [
        { opacity: 0, transform: w < 600 ? "translateY(16px)" : "scale(.94)" },
        { opacity: 1, transform: w < 600 ? "translateY(0)" : "scale(1)" },
      ],
      240,
    );
    panel.querySelector(".close").focus({ preventScroll: true });
  }
  function announce(t, canUndo = false) {
    notice.textContent = t;
    if (canUndo) {
      const b = document.createElement("button");
      b.textContent = "Undo";
      b.onclick = () => {
        undo?.();
        undo = null;
        notice.textContent = "Restored.";
      };
      notice.append(b);
    }
    setTimeout(() => {
      if (!canUndo) notice.textContent = "";
    }, 2600);
  }
  function changeFamily(i) {
    overview = false;
    root.querySelector(".explore em").textContent = "Drag to explore";
    family = i;
    pan = 0;
    panel.hidden = true;
    selected = null;
    menu.hidden = true;
    build();
    openBranches();
    root.querySelector("[data-action=families]").focus();
  }
  function choosePreset(i) {
    leaveDraft(() => {
      const previous = selectedIds(draft.record);
      preset = i;
      usePreset();
      menu.hidden = true;
      panel.hidden = true;
      selected = null;
      refresh();
      const current = selectedIds(draft.record);
      for (const id of new Set([...previous, ...current])) {
        if (previous.has(id) !== current.has(id)) acknowledgeSkill(id);
      }
    });
  }
  function openMenu(html) {
    close();
    menu.innerHTML =
      '<button class="close" aria-label="Close menu">×</button>' + html;
    menu.hidden = false;
    animateElement(menu, [
      { opacity: 0, transform: "translateY(-7px)" },
      { opacity: 1, transform: "translateY(0)" },
    ]);
    menu.querySelector(".close").onclick = () => {
      menu.hidden = true;
      root.querySelector("[data-action=options]").focus();
    };
  }
  function familyOptions() {
    const selectedMode = draft.record.skillPlugins[fam().id]?.mode || "off";
    openMenu(
      '<div class="eyebrow">' +
        esc(fam().name) +
        " · " +
        fam().skills.length +
        " skills</div><h3>Family selection</h3><p>" +
        fam().skills.filter(isOn).length +
        " selected in " +
        esc(draft.name) +
        ".</p>" +
        [
          [
            "full",
            "Whole plugin",
            "All skills, hooks, agents and integrations",
          ],
          [
            "subset",
            "All skills only",
            "Select every skill without plugin extras",
          ],
          ["off", "Off", "Exclude this family"],
        ]
          .map(
            ([mode, label, desc]) =>
              '<button class="item" data-mode="' +
              mode +
              '">' +
              label +
              "<span>" +
              (selectedMode === mode ? "✓" : "") +
              '</span></button><p class="mode-help">' +
              desc +
              "</p>",
          )
          .join(""),
    );
    menu.querySelectorAll("[data-mode]").forEach(
      (b) =>
        (b.onclick = () => {
          const mode = b.dataset.mode;
          draft.record.skillPlugins[fam().id] = {
            mode,
            ...(mode === "subset"
              ? { skills: fam().skills.map((s) => s.key) }
              : {}),
          };
          changed();
          menu.hidden = true;
          draw();
        }),
    );
  }
  root.querySelector("[data-action=families]").onclick = () => {
    overview = true;
    pan = 0;
    menu.hidden = true;
    panel.hidden = true;
    selected = null;
    build();
    openBranches();
  };
  root.querySelector("[data-action=options]").onclick = () => presetMenu();
  root.querySelector("[data-action=create]").onclick = () => createPreset();
  root.querySelector("[data-action=settings]").onclick = () => presetEditor();
  root.querySelector("[data-action=save]").onclick = () => savePreset();
  root.querySelector("[data-action=cancel]").onclick = cancelEdits;
  root.querySelector("[data-action=back]").onclick = () => {
    pan = Math.max(0, pan - w * 0.45);
    draw();
  };
  root.querySelector("[data-action=next]").onclick = () => {
    pan = Math.min(maxPan(), pan + w * 0.45);
    draw();
  };
  canvas.onpointerdown = (e) => {
    drag = { x: e.clientX, pan };
    moved = false;
    canvas.setPointerCapture(e.pointerId);
  };
  canvas.onpointermove = (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    moved = Math.abs(dx) > 5;
    pan = Math.max(0, Math.min(maxPan(), drag.pan - dx));
    draw();
  };
  canvas.onpointerup = () => {
    drag = null;
    setTimeout(() => (moved = false), 0);
  };
  canvas.onpointercancel = () => {
    drag = null;
  };
  canvas.onwheel = (e) => {
    e.preventDefault();
    pan = Math.max(0, Math.min(maxPan(), pan + e.deltaX + e.deltaY));
    draw();
  };
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      close();
      menu.hidden = true;
      root.querySelector("[data-action=families]").focus();
    }
  });
  let overview = true,
    overviewNodes = [],
    overviewFamilies = [];
  function overviewGeometry() {
    const positions = [
      [450, 255],
      [1080, 270],
      [1230, 505],
      [1080, 745],
      [460, 745],
      [310, 505],
    ];
    overviewFamilies = DATA.families.map((f, i) => ({
      f,
      i,
      x:
        positions[i]?.[0] ??
        793 + 460 * Math.cos((i / DATA.families.length) * Math.PI * 2),
      y:
        positions[i]?.[1] ??
        505 + 290 * Math.sin((i / DATA.families.length) * Math.PI * 2),
      color: colors[i],
    }));
    overviewNodes = [];
    overviewFamilies.forEach((g) => {
      const count = g.f.skills.length,
        branches = Math.min(5, Math.ceil(count / 4)),
        direction = g.x < 793 ? -1 : 1;
      g.branches = [];
      for (let k = 0; k < branches; k++) {
        let chain = [];
        const branchCount = Math.ceil((count - k) / branches);
        for (let j = 0; j < branchCount; j++) {
          const index = k + j * branches;
          if (index >= count) break;
          const reach =
            65 +
            ((j + 1) / branchCount) *
              (g.i === 1 ? 300 : 215) *
              (0.78 + rnd(k + g.i * 37) * 0.23) +
            (rnd(index + 61) - 0.5) * 20;
          const spread = (k - (branches - 1) / 2) * (g.i === 1 ? 45 : 38);
          const p = {
            s: g.f.skills[index],
            family: g.i,
            x: g.x + direction * reach,
            y:
              g.y +
              spread * (0.3 + (j + 1) / branchCount) +
              (rnd(index + g.i * 81) - 0.5) * 34,
            branch: k,
          };
          chain.push(p);
          overviewNodes.push(p);
        }
        g.branches.push(chain);
      }
    });
    const nodes = overviewNodes.map((p) => ({
      p,
      x: OX(p.x) + pan,
      y: OY(p.y),
    }));
    const minGap = 34;
    const hubs = overviewFamilies.map((g) => ({
      x: OX(g.x) + pan,
      y: OY(g.y),
    }));
    for (let pass = 0; pass < 180; pass++) {
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = b.x - a.x,
            dy = b.y - a.y,
            d = Math.hypot(dx, dy);
          if (d < minGap) {
            if (d < 0.01) {
              dx = 1;
              dy = 0;
              d = 1;
            }
            const push = (minGap - d) * 0.51;
            a.x -= (dx / d) * push;
            a.y -= (dy / d) * push;
            b.x += (dx / d) * push;
            b.y += (dy / d) * push;
          }
        }
        for (const hub of hubs) {
          // Reserve the family ring and its title below it.
          const dx = a.x - hub.x,
            dy = a.y - (hub.y + 24);
          const rx = 85,
            ry = 108;
          const d = Math.hypot(dx / rx, dy / ry);
          if (d < 1) {
            const safe = Math.max(d, 0.01);
            a.x = hub.x + dx / safe;
            a.y = hub.y + 24 + dy / safe;
          }
        }
        a.x = Math.max(20, Math.min(Math.max(w, 1280) - 20, a.x));
        a.y = Math.max(145, Math.min(h - 155, a.y));
      }
    }
    nodes.forEach(({ p, x, y }) => {
      p.x = (x * 1586) / Math.max(w, 1280);
      const os = Math.max(w, 1280) / 1586;
      p.y = (y - (h - 992 * os) / 2) / os;
    });
  }
  function OX(x) {
    return (x * Math.max(w, 1280)) / 1586 - pan;
  }
  function OY(y) {
    const os = Math.max(w, 1280) / 1586;
    return y * os + (h - 992 * os) / 2;
  }
  function revealOverview(x) {
    const screen = OX(x);
    if (screen < 40 || screen > w - 40) {
      pan = Math.max(0, Math.min(maxPan(), pan + screen - w / 2));
      draw();
    }
  }
  function buildOverview() {
    overviewGeometry();
    layer.innerHTML = "";
    buttons = [];
    overviewFamilies.forEach((g) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "family overview-family";
      b.style.color = g.color;
      b.innerHTML =
        '<span class="glyph"><i data-lucide="' +
        ["triangle", "hexagon", "palette", "sparkles", "orbit", "diamond"][
          g.i % 6
        ] +
        '"></i></span><span class="caption"><b>' +
        esc(g.f.name) +
        "</b><small>" +
        g.f.skills.length +
        " skills</small></span>";
      b.setAttribute(
        "aria-label",
        "Open " + g.f.name + ", " + g.f.skills.length + " skills",
      );
      b.onclick = () => changeFamily(g.i);
      b.dataset.overviewFamily = g.i;
      b.onfocus = () => revealOverview(g.x);
      layer.append(b);
    });
    overviewNodes.forEach((p) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "node overview-node";
      b.dataset.skill = p.s.id;
      b.onfocus = () => revealOverview(p.x);
      b.setAttribute(
        "aria-label",
        p.s.key + " in " + DATA.families[p.family].name,
      );
      b.innerHTML = "<span>" + esc(p.s.key) + "</span>";
      b.onclick = () => {
        if (editMode) toggleSkill(p.s, DATA.families[p.family]);
        else {
          changeFamily(p.family);
          inspect(p.s);
        }
      };
      p.button = b;
      layer.append(b);
    });
    root.querySelector(".trail").textContent = "/   All families";
    root.querySelector(".explore em").textContent =
      "Select a family to explore";
    if (globalThis.lucide) lucide.createIcons();
    draw();
  }
  function drawOverview() {
    overviewGeometry();
    ctx.clearRect(0, 0, w, h);
    const grad = ctx.createRadialGradient(
      w / 2,
      h / 2,
      0,
      w / 2,
      h / 2,
      w * 0.7,
    );
    grad.addColorStop(0, "#242239");
    grad.addColorStop(1, "#151525");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#77718a12";
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    for (let x = 0; x < w; x += 44) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    for (let y = 16; y < h; y += 44) {
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();
    for (let i = 0; i < 65; i++)
      dot(
        rnd(i + 3) * w,
        rnd(i + 71) * h,
        rnd(i + 10) * 1.1,
        "#b6adce",
        0.12 + rnd(i + 20) * 0.13,
      );
    const os = Math.max(w, 1280) / 1586,
      cx = OX(793),
      cy = OY(505),
      radius = Math.max(34, 44 * os);
    overviewFamilies.forEach((g) => {
      const x = OX(g.x),
        y = OY(g.y);
      ctx.setLineDash([1, 7]);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x, y);
      ctx.strokeStyle = g.color + "45";
      ctx.stroke();
      ctx.setLineDash([]);
      g.branches.forEach((chain, branchIndex) => {
        let a =
          branchIndex % 2 === 1
            ? g.branches[branchIndex - 1][0]
            : { x: g.x, y: g.y };
        chain.forEach((p, j) => {
          const ax = OX(a.x),
            ay = OY(a.y),
            px = OX(p.x),
            py = OY(p.y);
          const on = models[preset].has(p.s.id),
            r = overviewNodeRadius();
          const fromHub = a.x === g.x && a.y === g.y;
          strokeBranch(
            ctx,
            [ax, ay],
            [px, py],
            on ? g.color + "85" : "#c5bec43d",
            1,
            fromHub ? radius + 2 : r + 2,
            r + 2,
          );
          if (on) {
            dot(px, py, r + 4, g.color, 0.08);
            dot(px, py, r, g.color);
          } else ring(px, py, r, "#d3cbd5a0", 0.8);
          a = p;
        });
      });
      ctx.fillStyle = "#1b1c30";
      ctx.beginPath();
      ctx.arc(x, y, radius + 5, 0, 7);
      ctx.fill();
      ring(x, y, radius + 7, g.color + "25", 0.8);
      ring(x, y, radius, g.color, 1.1);
      const b = layer.querySelector('[data-overview-family="' + g.i + '"]');
      b.style.left = x + "px";
      b.style.top = y + "px";
      b.style.width = radius * 2 + "px";
      b.style.height = radius * 2 + "px";
      b.style.margin = -radius + "px";
    });
    layer.querySelectorAll(".overview-node").forEach((b, i) => {
      const p = overviewNodes[i];
      markChange(b, p.s);
      b.style.left = OX(p.x) + "px";
      b.style.top = OY(p.y) + "px";
      if (editMode) {
        b.setAttribute("aria-pressed", String(models[preset].has(p.s.id)));
        b.removeAttribute("aria-haspopup");
      } else {
        b.removeAttribute("aria-pressed");
        b.setAttribute("aria-haspopup", "dialog");
      }
      b.setAttribute(
        "aria-label",
        p.s.key +
          " in " +
          DATA.families[p.family].name +
          (models[preset].has(p.s.id)
            ? ", selected in preset"
            : ", not selected"),
      );
    });
    paintCore();
    root
      .querySelectorAll("[data-preset]")
      .forEach((b) =>
        b.setAttribute("aria-pressed", Number(b.dataset.preset) === preset),
      );
    root.querySelector(".session").textContent =
      DATA.families.reduce((n, f) => n + f.skills.length, 0) +
      " skills · " +
      models[preset].size +
      " selected" +
      (dirty ? " · unsaved" : "");
    root.querySelector("[data-action=back]").disabled = pan <= 0;
    root.querySelector("[data-action=next]").disabled = pan >= maxPan();
  }

  async function api(path, body) {
    const response = await fetch(path, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: "Bearer " + (token || ""),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(
        result.error || "CLX could not complete this request.",
      );
      error.status = response.status;
      throw error;
    }
    return result;
  }
  function normalize(record = {}) {
    return {
      ...structuredClone(record),
      model: record.model || DATA.models[0]?.id || "",
      effort: record.effort || "",
      skillPlugins: structuredClone(record.skillPlugins || {}),
      otherPlugins: [...(record.otherPlugins || [])],
      mcp: [...(record.mcp || [])],
    };
  }
  function selectedIds(record) {
    const ids = new Set();
    for (const f of DATA.families) {
      const selection = record.skillPlugins?.[f.id];
      if (selection?.mode === "full") f.skills.forEach((s) => ids.add(s.id));
      else if (selection?.mode === "subset")
        selection.skills.forEach((key) => ids.add(f.id + "/" + key));
    }
    return ids;
  }
  function usePreset() {
    preset = Math.min(preset, Math.max(0, DATA.presets.length - 1));
    const saved = DATA.presets[preset];
    originalName = saved?.name ?? null;
    draft = {
      name: saved?.name || "New preset",
      record: normalize(saved?.record),
    };
    dirty = false;
  }
  function renderWelcome() {
    const welcome = root.querySelector(".welcome");
    const visible = !DATA.presets.length && !dirty && !editMode;
    welcome.hidden = !visible;
    if (!visible) return;
    const hasSkills = DATA.families.some((f) => f.skills.length);
    if (namingFirstPreset) {
      welcome.innerHTML = `<h2>Name your preset</h2><p>Give it a name for the kind of work you want to do.</p>
        <form data-first-form><label for="first-preset-name">Preset name</label>
        <input id="first-preset-name" name="name" placeholder="For example, Code review" required maxlength="120" autocomplete="off">
        <div class="row"><button class="control primary" type="submit">${hasSkills ? "Choose skills" : "Create preset"}</button><button class="plain" type="button" data-first-back>Back</button></div></form>`;
      welcome.querySelector("[data-first-back]").onclick = () => {
        namingFirstPreset = false;
        renderWelcome();
        welcome.querySelector("[data-first-create]").focus();
      };
      welcome.querySelector("form").onsubmit = (e) => {
        e.preventDefault();
        const input = welcome.querySelector("input"),
          name = input.value.trim();
        input.setCustomValidity(name ? "" : "Enter a preset name.");
        if (!input.reportValidity()) return;
        namingFirstPreset = false;
        createPreset(name);
        root.querySelector("[data-mode-edit]").focus();
      };
      welcome.querySelector("input").oninput = (e) =>
        e.target.setCustomValidity("");
      return;
    }
    welcome.innerHTML = hasSkills
      ? `<h2>Create your first preset</h2><p>Choose the skills you want Claude to use for a particular kind of work.</p><button class="control primary" data-first-create>Create a preset</button><small>Name it. Choose skills. Save it.</small>`
      : `<h2>Build your skill constellation</h2><p>No skill plugins found yet. Install a skill-bearing plugin in Claude Code, then run this in your terminal:</p><code>clx init --force</code><div class="row"><button class="control primary" data-first-reload>Reload skills</button><button class="plain" data-first-create>Create a preset without skills</button></div><small>You can save a model-only preset now and add skills later.</small>`;
    welcome.querySelector("[data-first-create]").onclick = () => {
      namingFirstPreset = true;
      renderWelcome();
      welcome.querySelector("input").focus();
    };
    const reload = welcome.querySelector("[data-first-reload]");
    if (reload) reload.onclick = () => load();
  }
  function renderChrome() {
    renderWelcome();
    root.querySelector("[data-action=cancel]").hidden = !editMode && !dirty;
    const changes = DATA.families.flatMap((f) => f.skills).map(skillChange);
    const added = changes.filter((c) => c === "added").length;
    const removed = changes.filter((c) => c === "removed").length;
    const summary = root.querySelector(".edit-summary");
    summary.hidden = !editMode && !dirty;
    summary.textContent =
      added || removed
        ? `+ ${added} added · − ${removed} removed · Unsaved`
        : DATA.presets.length === 0
          ? DATA.families.some((f) => f.skills.length)
            ? "Click skills to include them, then save your preset."
            : "Save your model-only preset. You can add skills later in Edit mode."
          : "Click skills to toggle · Save to keep · Cancel to discard";

    root.querySelector(".preset-picker").textContent = draft.name + " ▾";
    root.querySelector("[data-action=save]").disabled = !dirty || busy;
    root.querySelector("[data-action=save]").textContent = busy
      ? "Saving…"
      : "Save";
    const indices = DATA.presets.map((_, i) => i);
    root.querySelector(".foot").innerHTML = indices
      .map(
        (i) =>
          '<button class="preset" data-preset="' +
          i +
          '" aria-pressed="' +
          (originalName !== null && i === preset) +
          '">' +
          esc(DATA.presets[i].name) +
          "</button>",
      )
      .join("");
    root
      .querySelectorAll("[data-preset]")
      .forEach((b) => (b.onclick = () => choosePreset(+b.dataset.preset)));
  }
  function refresh() {
    models = DATA.presets.map((p) => selectedIds(p.record));
    models[preset] = selectedIds(draft.record);
    renderChrome();
    draw();
  }
  function changed() {
    dirty = true;
    refresh();
  }
  function leaveDraft(continuation) {
    if (!dirty) {
      continuation();
      return;
    }
    openMenu(
      '<div class="eyebrow">Unsaved changes</div><h3>Keep your changes?</h3><p>Save “' +
        esc(draft.name) +
        '” before switching, or discard your edits.</p><div class="row"><button class="control primary" data-save-first>Save & continue</button><button class="control" data-discard>Discard</button><button class="plain" data-stay>Keep editing</button></div>',
    );
    menu.querySelector("[data-save-first]").onclick = async () => {
      if (await savePreset()) continuation();
    };
    menu.querySelector("[data-discard]").onclick = () => {
      dirty = false;
      continuation();
    };
    menu.querySelector("[data-stay]").onclick = () => {
      menu.hidden = true;
    };
  }
  function presetMenu() {
    openMenu(
      '<div class="eyebrow">Your presets</div><div class="preset-list">' +
        DATA.presets
          .map(
            (p, i) =>
              '<button class="item" data-choice="' +
              i +
              '"><strong>' +
              esc(p.name) +
              "</strong><span>" +
              selectedIds(p.record).size +
              "</span></button>",
          )
          .join("") +
        '</div><button class="item" data-new>+ New preset</button><button class="item" data-edit>Edit current preset</button><button class="item" data-reload>Reload from disk</button>' +
        (originalName
          ? '<button class="item" data-launch ' +
            (dirty ? "disabled" : "") +
            ">Launch in terminal <span>↗</span></button>"
          : "") +
        "<p>Launch opens Claude in the terminal where you ran clx ui.</p>" +
        (DATA.warnings.length
          ? '<p class="warning">' +
            DATA.warnings.length +
            ' skill files need attention. <button class="plain" data-warnings>Show details</button></p>'
          : ""),
    );
    menu
      .querySelectorAll("[data-choice]")
      .forEach((b) => (b.onclick = () => choosePreset(+b.dataset.choice)));
    menu.querySelector("[data-new]").onclick = createPreset;
    menu.querySelector("[data-edit]").onclick = presetEditor;
    menu.querySelector("[data-reload]").onclick = () =>
      leaveDraft(() => load());
    if (menu.querySelector("[data-launch]"))
      menu.querySelector("[data-launch]").onclick = launch;
    if (menu.querySelector("[data-warnings]"))
      menu.querySelector("[data-warnings]").onclick = () => {
        openMenu(
          '<div class="eyebrow">Catalog needs attention</div><h3>Refresh your installed skills</h3><p>Run <code>clx init --force</code> in another terminal, then reload the catalog here.</p><ul>' +
            DATA.warnings.map((t) => "<li>" + esc(t) + "</li>").join("") +
            '<button class="control" data-refresh>Reload</button>',
        );
        menu.querySelector("[data-refresh]").onclick = () =>
          leaveDraft(() => load());
      };
  }
  function createPreset(firstName) {
    if (!DATA.presets.length && !dirty && typeof firstName !== "string") {
      namingFirstPreset = true;
      renderWelcome();
      root.querySelector(".welcome input").focus();
      return;
    }
    leaveDraft(() => {
      originalName = null;
      preset = DATA.presets.length;
      let name = "New preset",
        n = 2;
      while (DATA.presets.some((p) => p.name === name))
        name = "New preset " + n++;
      draft = {
        name: typeof firstName === "string" ? firstName : name,
        record: normalize(),
      };
      dirty = true;
      menu.hidden = true;
      refresh();
      if (typeof firstName === "string") setEditMode(true);
      else presetEditor();
    });
  }
  function presetEditor() {
    panel.classList.remove("skill-details");
    delete panel.dataset.placement;
    setEditMode(true);
    menu.hidden = true;
    selected = null;
    locatePanel();
    panel.hidden = false;
    panel.classList.add("preset-editor");
    const records = DATA.models.some((m) => m.id === draft.record.model)
      ? DATA.models
      : [
          ...DATA.models,
          {
            id: draft.record.model,
            label: draft.record.model + " (not in catalog)",
          },
        ];
    const checkboxList = (field, choices) => {
      const selected = new Set(draft.record[field]);
      const all = [
        ...choices,
        ...[...selected]
          .filter((id) => !choices.some((c) => c.id === id))
          .map((id) => ({ id, name: id + " (unavailable)" })),
      ];
      return all.length
        ? all
            .map(
              (c) =>
                '<label class="check"><input type="checkbox" data-field="' +
                field +
                '" value="' +
                esc(c.id) +
                '" ' +
                (selected.has(c.id) ? "checked" : "") +
                "><span>" +
                esc(c.name) +
                "</span></label>",
            )
            .join("")
        : '<p class="muted">None in your catalog.</p>';
    };
    panel.innerHTML =
      '<button class="close" aria-label="Close preset editor">×</button><div class="eyebrow">' +
      (originalName ? "Edit preset" : "New preset") +
      '</div><h3>Your session loadout</h3><label>Preset name<input data-name required maxlength="120" value="' +
      esc(draft.name) +
      '"></label><label>Model<select data-model>' +
      records
        .map(
          (m) =>
            '<option value="' +
            esc(m.id) +
            '" ' +
            (m.id === draft.record.model ? "selected" : "") +
            ">" +
            esc(m.label || m.id) +
            "</option>",
        )
        .join("") +
      "</select></label><label>Reasoning effort<select data-effort>" +
      ["", "low", "medium", "high", "xhigh", "max"]
        .map(
          (e) =>
            '<option value="' +
            e +
            '" ' +
            (e === draft.record.effort ? "selected" : "") +
            ">" +
            esc(e || "Model default") +
            "</option>",
        )
        .join("") +
      "</select></label><p>Choose skills in the constellation. Click a family’s centre to choose whole-plugin or skills-only loading.</p><details><summary>MCP servers · " +
      draft.record.mcp.length +
      "</summary>" +
      checkboxList(
        "mcp",
        DATA.mcpNames.map((id) => ({ id, name: id })),
      ) +
      "</details><details><summary>Other plugins · " +
      draft.record.otherPlugins.length +
      "</summary>" +
      checkboxList("otherPlugins", DATA.otherPlugins) +
      '</details><div class="row"><button class="control primary" data-save>Save preset</button><button class="plain" data-discard-edit>Discard edits</button>' +
      (originalName
        ? '<button class="plain danger" data-delete>Delete preset</button>'
        : "") +
      '</div><p class="form-error" role="alert"></p>';
    panel.querySelector(".close").onclick = () => {
      panel.hidden = true;
      panel.classList.remove("preset-editor");
      root.querySelector("[data-action=settings]").focus();
    };
    panel.querySelector("[data-name]").oninput = (e) => {
      draft.name = e.target.value;
      changed();
    };
    panel.querySelector("[data-model]").onchange = (e) => {
      draft.record.model = e.target.value;
      changed();
    };
    panel.querySelector("[data-effort]").onchange = (e) => {
      draft.record.effort = e.target.value;
      changed();
    };
    panel.querySelectorAll("[data-field]").forEach(
      (input) =>
        (input.onchange = () => {
          const key = input.dataset.field;
          draft.record[key] = [
            ...panel.querySelectorAll('[data-field="' + key + '"]:checked'),
          ].map((e) => e.value);
          changed();
        }),
    );
    panel.querySelector("[data-save]").onclick = () => savePreset();
    panel.querySelector("[data-discard-edit]").onclick = () => {
      usePreset();
      panel.hidden = true;
      refresh();
    };
    if (originalName)
      panel.querySelector("[data-delete]").onclick = deletePreset;
    panel.querySelector("[data-name]").focus();
    draw();
  }
  function showError(error) {
    const box = panel.querySelector(".form-error");
    if (box && !panel.hidden) box.textContent = error.message;
    notice.textContent = error.message;
    if (error.status === 409) {
      const reload = document.createElement("button");
      reload.textContent = "Reload";
      reload.onclick = () => leaveDraft(() => load());
      notice.append(reload);
    }
  }
  async function savePreset() {
    if (busy) return false;
    const name = draft.name.trim();
    if (!name) {
      showError(new Error("Give this preset a name."));
      return false;
    }
    busy = true;
    root.inert = true;
    renderChrome();
    try {
      const result = await api("/api/presets", {
        operation: originalName ? "update" : "create",
        name,
        previousName: originalName,
        record: draft.record,
        revision,
      });
      DATA.presets = result.presets;
      revision = result.revision;
      preset = DATA.presets.findIndex((p) => p.name === name);
      usePreset();
      panel.hidden = true;
      menu.hidden = true;
      refresh();
      announce("Preset saved. Ready in clx.");
      return true;
    } catch (error) {
      showError(error);
      return false;
    } finally {
      busy = false;
      root.inert = false;
      renderChrome();
    }
  }
  function deletePreset() {
    const name = originalName;
    if (!name) return;
    panel.hidden = true;
    openMenu(
      '<div class="eyebrow">Delete preset</div><h3>Delete “' +
        esc(name) +
        '”?</h3><p>This removes the saved preset from CLX. Your installed skills are kept.</p><div class="row"><button class="control danger" data-confirm-delete>Delete preset</button><button class="control" data-cancel-delete>Cancel</button></div>',
    );
    menu.querySelector("[data-cancel-delete]").onclick = presetEditor;
    menu.querySelector("[data-confirm-delete]").onclick = async () => {
      if (busy) return;
      busy = true;
      root.inert = true;
      try {
        const result = await api("/api/presets", {
          operation: "delete",
          name,
          revision,
        });
        DATA.presets = result.presets;
        revision = result.revision;
        preset = 0;
        usePreset();
        menu.hidden = true;
        refresh();
        announce("Preset deleted. A backup was saved.");
      } catch (error) {
        showError(error);
      } finally {
        busy = false;
        root.inert = false;
        renderChrome();
      }
    };
  }
  async function launch() {
    if (dirty) return;
    try {
      await api("/api/launch", { name: originalName });
      menu.hidden = true;
      announce("Session launched. Continue in your terminal.");
    } catch (error) {
      showError(error);
    }
  }
  async function load() {
    const loading = root.querySelector(".load-state");
    loading.hidden = false;
    loading.textContent = "Reading your CLX configuration…";
    try {
      const preferred = originalName;
      DATA = await api("/api/state");
      revision = DATA.revision;
      colors = DATA.families.map(
        (_, i) =>
          ["#b39be5", "#79c9c3", "#dda1b5", "#e7bd7f", "#92b9e3", "#c2ad76"][
            i % 6
          ],
      );
      preset = Math.max(
        0,
        DATA.presets.findIndex((p) => p.name === preferred),
      );
      usePreset();
      family = Math.min(family, Math.max(0, DATA.families.length - 1));
      overview = true;
      selected = null;
      menu.hidden = true;
      panel.hidden = true;
      notice.textContent = "";
      models = DATA.presets.map((p) => selectedIds(p.record));
      models[preset] = selectedIds(draft.record);
      renderChrome();
      build();
      resize();
      loading.hidden = true;

      if (DATA.warnings.length) {
        notice.innerHTML =
          "<span>" +
          DATA.warnings.length +
          " skill files unavailable.</span> <button>Details</button>";
        notice.querySelector("button").onclick = presetMenu;
      }
      root.querySelector(".chrome").hidden = false;
    } catch (error) {
      loading.innerHTML =
        "<h2>CLX needs your attention</h2><p>" +
        esc(error.message) +
        '</p><p>New installation? Run <code>clx init</code> in your terminal.</p><button class="control">Try again</button>';
      loading.querySelector("button").onclick = load;
    }
  }
  window.addEventListener("beforeunload", (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  new ResizeObserver(() => {
    resize();
    if (overview && draft) buildOverview();
  }).observe(root);
  root.querySelector("[data-mode-view]").onclick = () => setEditMode(false);
  root.querySelector("[data-mode-edit]").onclick = () => setEditMode(true);
  reducedMotion.addEventListener("change", () => {
    if (reducedMotion.matches)
      root.getAnimations({ subtree: true }).forEach((a) => a.cancel());
    startMotion();
  });
  document.addEventListener("visibilitychange", startMotion);
  document.fonts.ready.then(() => {
    layoutLabels();
    draw();
  });
  startMotion();
  load();
})();
