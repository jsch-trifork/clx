import { chromium } from "playwright";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { Profiles } from "../src/profiles.mjs";
import { initializeCatalog } from "../src/setup.mjs";
import { startServer } from "../src/server.mjs";

const dir = await mkdtemp(join(tmpdir(), "clx-e2e-"));
const catalogFile = join(dir, "loadout.json"),
  presetsFile = join(dir, "presets.json");
const families = [];
for (const [i, name] of [
  "Frontend",
  "Workflow",
  "Design",
  "Utilities",
  "Engineering",
  "Accessibility",
].entries()) {
  const skills = [];
  for (let n = 0; n < [7, 35, 14, 15, 14, 7][i]; n++) {
    const folder = join(dir, name, "skill-" + n);
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "SKILL.md"),
      "---\nname: skill-" + n + "\ndescription: Test skill " + n + "\n---\n",
    );
    skills.push({ dir: folder, label: "skill-" + n });
  }
  families.push({ id: name.toLowerCase() + "@test", name, skills });
}
await writeFile(
  catalogFile,
  JSON.stringify({
    models: [{ id: "sonnet", label: "Sonnet" }],
    skillPlugins: families,
    mcpServers: { docs: { command: "test" } },
    otherPlugins: [],
  }),
);
const initial = {
  Existing: {
    model: "sonnet",
    skillPlugins: { "workflow@test": { mode: "full" } },
    mcp: [],
    otherPlugins: [],
    prompt: "preserve-me",
  },
};
await writeFile(presetsFile, JSON.stringify(initial));
const profiles = new Profiles(dir, catalogFile);
let launches = 0;
const { server, url } = await startServer({
  catalogFile,
  presetsFile,
  onVersion: async () => ({
    current: "0.1.5",
    latest: "0.1.6",
    available: true,
    command: "clx update",
  }),
  getCatalogFile: () => profiles.catalog(),
  onProfiles: async (request) =>
    !request
      ? profiles.list()
      : request.operation === "select"
        ? profiles.select(request.id)
        : profiles.mutate(request),
  onLaunch: async () => {
    launches++;
  },
  onSetup: async (request) => {
    if (request) await initializeCatalog(catalogFile, request.directory, true);
    return { directory: join(dir, "alternate profile") };
  },
});
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CLX_TEST_BROWSER
      ? { executablePath: process.env.CLX_TEST_BROWSER }
      : {}),
  });
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 860 } }),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: new URL(url).origin,
      });
    await page.goto(url);
    await page.locator(".overview-family").first().waitFor();
    assert.equal(await page.locator(".overview-node").count(), 92);
    const updateNotice = page.locator(".update-status");
    await updateNotice.waitFor();
    await updateNotice.locator("summary").click();
    assert.equal(await updateNotice.locator("code").innerText(), "clx update");
    const updateBounds = await updateNotice.boundingBox();
    assert(updateBounds.x >= 0 && updateBounds.x + updateBounds.width <= width);
    await page.screenshot({ path: `/tmp/clx-update-notice-${width}.png` });
    await page
      .getByRole("button", { name: "Copy command", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector('.update-status [role="status"]').textContent ===
        "Copied",
    );
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      "clx update",
    );
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: async () => {
          throw new DOMException("Clipboard access denied", "NotAllowedError");
        },
      });
    });
    await page
      .getByRole("button", { name: "Copy command", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector('.update-status [role="status"]').textContent ===
        "Select and copy the command above.",
    );
    assert.equal(await updateNotice.locator("code").innerText(), "clx update");
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    assert.equal(await updateNotice.isVisible(), false);
    const newPreset = page.getByRole("button", {
      name: "Create preset",
      exact: true,
    });
    assert.match(await newPreset.innerText(), /New preset/);
    const createBounds = await newPreset.boundingBox();
    assert(createBounds.x >= 0 && createBounds.x + createBounds.width <= width);
    await newPreset.click();
    await page.locator("[data-name]").fill("New " + width);
    await page.locator(".inspector .close").click();
    await page.locator('[data-overview-family="1"]').focus();
    await page.locator('[data-overview-family="1"]').click();
    for (const label of await page.locator(".node span").all())
      assert.equal(
        await label.evaluate((e) => getComputedStyle(e).opacity),
        "1",
      );
    const skill = page.locator(".node").first();
    await skill.focus();
    assert.equal(await skill.getAttribute("aria-pressed"), "false");
    await skill.click();
    assert.equal(await skill.getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator(".inspector").isVisible(), false);
    const back = page.getByRole("button", {
      name: "Back to all skills",
      exact: true,
    });
    assert.equal(await back.isVisible(), true);
    const backBounds = await back.boundingBox();
    assert(backBounds.x >= 0 && backBounds.x + backBounds.width <= width);
    await page.screenshot({ path: `/tmp/clx-back-${width}.png` });
    await back.click();
    assert.equal(await page.locator(".overview-family").count(), 6);
    assert.equal(
      await page.locator("[data-mode-edit]").getAttribute("aria-pressed"),
      "true",
    );
    await page.locator('[data-overview-family="1"]').focus();
    await page.locator('[data-overview-family="1"]').click();
    await skill.focus();
    assert.equal(await skill.getAttribute("aria-pressed"), "true");

    await skill.click();
    assert.equal(await skill.getAttribute("aria-pressed"), "false");
    await page.locator("[data-action=save]").click();
    await page.waitForFunction(
      () => !document.querySelector("#clx-atlas").inert,
    );
    await page.waitForFunction(
      () => document.querySelector("[data-action=save]").disabled,
    );
    await page.locator("[data-mode-view]").click();
    await skill.click();
    assert.equal(await page.locator(".inspector").isVisible(), true);
    await page.locator(".skill-details").evaluate(async (el) => {
      await Promise.all(
        el.getAnimations().map((a) => a.finished.catch(() => {})),
      );
    });
    const detailBounds = await page.locator(".skill-details").boundingBox();
    assert(
      detailBounds.x >= 15 && detailBounds.x + detailBounds.width <= width - 15,
    );
    assert(detailBounds.y >= 95 && detailBounds.y + detailBounds.height <= 845);
    if (width < 600)
      assert.equal(
        await page.locator(".skill-details").getAttribute("data-placement"),
        "bottom",
      );

    assert.equal(await page.locator("[data-do=toggle]").count(), 0);
    await page.locator(".inspector .close").click();
    await page.locator("[data-mode-edit]").click();
    await page.locator("[data-main]").click();
    assert.equal(await page.locator('.node[aria-pressed="true"]').count(), 35);
    assert.equal(
      await page.locator("[data-main]").getAttribute("aria-pressed"),
      "true",
    );
    await page.locator("[data-main]").click();
    assert.equal(await page.locator('.node[aria-pressed="true"]').count(), 0);
    await page.locator("[data-main]").click();
    await page.locator("[data-mode-view]").click();
    await page
      .getByRole("button", { name: "Save & continue", exact: true })
      .click();
    await page.locator("[data-main]").click();
    await page.locator("[data-mode=full]").click();
    await page.locator("[data-mode-edit]").click();
    await page.locator("[data-action=save]").click();
    await page.waitForFunction(
      () => !document.querySelector("#clx-atlas").inert,
    );
    await page.waitForFunction(() =>
      document.querySelector(".notice").textContent.includes("Preset saved"),
    );
    assert.equal(
      JSON.parse(await readFile(presetsFile))["New " + width].skillPlugins[
        "workflow@test"
      ].mode,
      "full",
    );
    await skill.focus();
    await skill.click();
    assert.equal(await skill.getAttribute("data-change"), "removed");
    await page.locator("[data-action=cancel]").click();
    assert.equal(await skill.getAttribute("data-change"), "");
    assert.equal(await page.locator("[data-action=save]").isDisabled(), true);
    assert.equal(
      await page.locator("[data-mode-view]").getAttribute("aria-pressed"),
      "true",
    );
    await page.reload();
    await page.locator(".overview-family").first().waitFor();
    await page.locator("[data-action=options]").click();
    await page
      .getByRole("button", { name: "New " + width + " 35", exact: true })
      .click();
    await page.locator("[data-action=settings]").click();
    await page.locator("[data-name]").fill("Renamed " + width);
    await page.locator("[data-save]").click();
    await page.waitForFunction(() =>
      document.querySelector(".notice").textContent.includes("Preset saved"),
    );
    await page.locator("[data-action=options]").click();
    await page
      .getByRole("button", { name: "Delete current preset", exact: true })
      .click();
    await page.locator("[data-confirm-delete]").click();
    await page.waitForFunction(() =>
      document.querySelector(".notice").textContent.includes("Preset deleted"),
    );
    const saved = JSON.parse(await readFile(presetsFile));
    assert(!saved["Renamed " + width]);
    assert.equal(saved.Existing.prompt, "preserve-me");
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.deepEqual(errors, []);
    console.log(
      width +
        ": create, select whole family, save, reload, rename, delete; no overflow or script errors",
    );
    await page.close();
  }
  for (const width of [1280, 390]) {
    for (const hasSkills of [true, false]) {
      await writeFile(presetsFile, "{}");
      await writeFile(
        catalogFile,
        JSON.stringify({
          models: [{ id: "sonnet", label: "Sonnet" }],
          skillPlugins: hasSkills ? families : [],
          otherPlugins: [],
          mcpServers: {},
        }),
      );
      const page = await browser.newPage({ viewport: { width, height: 860 } });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(url);
      await page.locator(".welcome").waitFor();
      await page.waitForTimeout(2800);
      assert.equal(await page.locator(".welcome").isVisible(), true);
      assert.equal(
        await page.locator("[data-first-reload]").count(),
        hasSkills ? 0 : 1,
      );
      await page.screenshot({
        path: `/tmp/clx-welcome-${width}-${hasSkills}.png`,
      });
      await page.locator("[data-first-create]").click();
      await page.locator("#first-preset-name").fill("Code review");
      await page.locator("[data-first-form] button[type=submit]").click();
      assert.equal(await page.locator(".welcome").isVisible(), false);
      assert.equal(
        await page.locator("[data-mode-edit]").getAttribute("aria-pressed"),
        "true",
      );
      await page.locator("[data-action=cancel]").click();
      assert.equal(await page.locator(".welcome").isVisible(), true);
      await page.locator("[data-first-create]").click();
      await page.locator("#first-preset-name").fill("Code review");
      await page.locator("[data-first-form] button[type=submit]").click();
      if (hasSkills) {
        await page.locator(".overview-node").first().focus();
        await page.locator(".overview-node").first().click();
        assert.equal(
          await page.locator('.overview-node[data-change="added"]').count(),
          1,
        );
      }
      await page.locator("[data-action=save]").click();
      await page.waitForFunction(
        () => !document.querySelector("#clx-atlas").inert,
      );
      assert(JSON.parse(await readFile(presetsFile))["Code review"]);
      await page.reload();
      await page.locator(".chrome").waitFor();
      assert.equal(await page.locator(".welcome").isVisible(), false);
      assert.deepEqual(errors, []);
      await page.close();
      console.log(
        `${width}: first preset with ${hasSkills ? "installed" : "no"} skills; persistent CTA, naming, Cancel, Save and reload passed`,
      );
    }
  }
  // A collection larger than the original six must occupy all sides without
  // overlapping hub labels, and every group must remain reachable by keyboard.
  const savedCatalog = await readFile(catalogFile);
  const savedPresets = await readFile(presetsFile);
  const manyFamilies = Array.from({ length: 18 }, (_, i) => ({
    ...families[i % families.length],
    id: `collection-${i}@test`,
    name: `Skillset ${i + 1}`,
  }));
  await writeFile(
    catalogFile,
    JSON.stringify({
      models: [{ id: "sonnet", label: "Sonnet" }],
      skillPlugins: manyFamilies,
      otherPlugins: [],
      mcpServers: {},
    }),
  );
  await writeFile(
    presetsFile,
    JSON.stringify({
      Existing: {
        model: "sonnet",
        skillPlugins: {},
        otherPlugins: [],
        mcp: [],
      },
    }),
  );
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 860 } });
    await page.goto(url);
    await page.locator(".overview-family").first().waitFor();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const hubs = page.locator(".overview-family");
    assert.equal(await hubs.count(), 18);
    for (const face of ["top", "bottom", "left", "right"])
      assert(
        (await page.locator(`.overview-family[data-face="${face}"]`).count()) >
          0,
      );
    const hubRects = await hubs.evaluateAll((items) =>
      items.map((e) => {
        const a = e.getBoundingClientRect(),
          b = e.querySelector(".caption").getBoundingClientRect();
        return {
          left: Math.min(a.left, b.left),
          right: Math.max(a.right, b.right),
          top: Math.min(a.top, b.top),
          bottom: Math.max(a.bottom, b.bottom),
        };
      }),
    );
    for (const [i, a] of hubRects.entries())
      for (const b of hubRects.slice(i + 1))
        assert(
          a.right <= b.left ||
            b.right <= a.left ||
            a.bottom <= b.top ||
            b.bottom <= a.top,
          "skillset hubs or names overlap",
        );
    assert(
      hubRects.some((a) => a.left >= 0 && a.right <= width),
      "initial view must contain a complete skillset and name",
    );
    const palette = await hubs.evaluateAll((items) =>
      items.map((e) => getComputedStyle(e).color),
    );
    assert.equal(new Set(palette).size, 18);
    await page.screenshot({ path: `/tmp/clx-many-skillsets-${width}.png` });
    for (const i of [0, 8, 14, 17]) {
      await hubs.nth(i).focus();
      const bounds = await hubs.nth(i).boundingBox();
      assert(bounds.x >= 0 && bounds.x + bounds.width <= width);
    }
    await hubs.nth(14).focus();
    await hubs.nth(14).click();
    await page
      .getByRole("button", { name: "Back to all skills", exact: true })
      .click();
    assert.equal(await hubs.count(), 18);
    await page.close();
    console.log(
      `${width}: 18 skillsets, four-sided layout, distinct colors, label separation and keyboard navigation passed`,
    );
  }
  await writeFile(catalogFile, savedCatalog);
  await writeFile(presetsFile, savedPresets);
  const alternate = join(dir, "alternate profile");
  const plugin = join(
    alternate,
    "plugins/cache/test/custom/1/skills/custom-skill",
  );
  await mkdir(plugin, { recursive: true });
  await writeFile(join(plugin, "SKILL.md"), "---\nname: custom-skill\n---\n");
  await writeFile(
    join(alternate, "settings.json"),
    JSON.stringify({ enabledPlugins: { "custom@test": true } }),
  );
  for (const width of [1280, 390]) {
    await rm(catalogFile);
    const page = await browser.newPage({ viewport: { width, height: 860 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(url);
    const input = page.getByLabel("Claude configuration folder");
    await input.waitFor();
    await page
      .getByRole("button", { name: "Scan this folder", exact: true })
      .waitFor();
    await input.fill(join(dir, "not found"));
    await page
      .getByRole("button", { name: "Scan this folder", exact: true })
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector("[data-setup-error]")
        .textContent.includes("does not exist"),
    );
    await input.fill(alternate);
    await page.screenshot({ path: `/tmp/clx-folder-setup-${width}.png` });
    const saved = await readFile(presetsFile, "utf8");
    await page
      .getByRole("button", { name: "Scan this folder", exact: true })
      .click();
    await page.locator(".overview-family").first().waitFor();
    assert.equal(await page.locator(".overview-node").count(), 1);
    assert.equal(await readFile(presetsFile, "utf8"), saved);
    assert.equal(
      JSON.parse(await readFile(catalogFile)).claudeConfigDir,
      alternate,
    );
    await page.reload();
    await page.locator(".overview-family").first().waitFor();
    assert.equal(await page.locator(".load-state").isVisible(), false);
    await page.locator("[data-action=options]").click();
    await page
      .getByRole("button", { name: "Claude configuration folder", exact: true })
      .click();
    await input.waitFor();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await page.locator(".load-state").isVisible(), false);
    assert.deepEqual(errors, []);
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.close();
    console.log(
      `${width}: missing catalog, invalid folder, alternate profile scan, restart and Cancel passed`,
    );
  }
  const emptyProfile = join(dir, "Customer B");
  await mkdir(emptyProfile);
  await writeFile(join(emptyProfile, "settings.json"), "{}");
  const shared = {
    Shared: {
      model: "sonnet",
      skillPlugins: { "custom@test": { mode: "full" } },
      mcp: [],
      otherPlugins: [],
    },
  };
  for (const width of [1280, 390]) {
    await rm(profiles.file, { force: true });
    profiles.activeId = "default";
    await writeFile(presetsFile, JSON.stringify(shared));
    const page = await browser.newPage({ viewport: { width, height: 860 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(url);
    await page.locator(".overview-family").first().waitFor();
    await page
      .getByRole("button", { name: "Choose Claude profile", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Add profile", exact: true })
      .click();
    await page.getByLabel("Profile name", { exact: true }).fill("Customer B");
    await page
      .getByLabel("Claude configuration folder", { exact: true })
      .fill(emptyProfile);
    await page.screenshot({ path: `/tmp/clx-profile-form-${width}.png` });
    await page
      .getByRole("button", { name: "Save profile", exact: true })
      .click();
    await page.getByRole("button", { name: "Customer B", exact: true }).click();
    await page.waitForFunction(() =>
      document
        .querySelector("[data-action=profiles]")
        .textContent.includes("Customer B"),
    );
    assert.equal(await page.locator(".overview-node").count(), 0);
    assert(
      await page
        .locator(".preset-picker")
        .textContent()
        .then((t) => t.includes("Shared")),
    );
    await page.locator("[data-action=options]").click();
    await page.locator("[data-launch]").click();
    await page
      .getByRole("button", { name: "Continue without these", exact: true })
      .waitFor();
    assert(
      await page
        .locator(".menu")
        .textContent()
        .then((t) => t.includes("custom@test")),
    );
    const before = launches;
    await page
      .getByRole("button", { name: "Continue without these", exact: true })
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector(".notice")
        .textContent.includes("Session launched"),
    );
    assert.equal(launches, before + 1);
    assert.deepEqual(JSON.parse(await readFile(presetsFile)), shared);
    await page
      .getByRole("button", { name: "Choose Claude profile", exact: true })
      .click();
    await page.getByRole("button", { name: "Default", exact: true }).click();
    await page.locator(".overview-family").first().waitFor();
    await page.locator("[data-mode-edit]").click();
    await page.locator(".overview-node").first().click();
    await page
      .getByRole("button", { name: "Choose Claude profile", exact: true })
      .click();
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await page
      .getByRole("button", { name: "Edit Customer B", exact: true })
      .waitFor();
    assert.equal(
      await page.locator('.overview-node[data-change="removed"]').count(),
      0,
    );
    assert.equal(await page.locator("[data-action=save]").isDisabled(), true);
    await page.screenshot({ path: `/tmp/clx-profile-chooser-${width}.png` });
    await page
      .getByRole("button", { name: "Edit Customer B", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Delete profile", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Confirm delete profile", exact: true })
      .click();
    await page.waitForFunction(
      () => !document.querySelector('[aria-label="Edit Customer B"]'),
    );
    assert.deepEqual(JSON.parse(await readFile(presetsFile)), shared);
    assert.deepEqual(errors, []);
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.close();
    console.log(
      `${width}: shared presets, profile create/switch/delete, dirty-edit discard and compatibility consent passed`,
    );
  }
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 860 } });
    await page.route("**/api/state", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: '{"error":"No catalog"}',
      }),
    );
    await page.route("**/api/profiles", (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: '{"error":"Unknown CLX endpoint."}',
      }),
    );
    await page.route("**/api/setup", (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: '{"error":"Unknown CLX endpoint."}',
      }),
    );
    await page.goto(url);
    const scan = page.getByRole("button", {
      name: "Scan this folder",
      exact: true,
    });
    await page.waitForFunction(() =>
      document
        .querySelector("[data-setup-error]")
        ?.textContent.includes("different versions"),
    );
    assert.equal(await scan.isEnabled(), true);
    await page
      .getByLabel("Claude configuration folder", { exact: true })
      .fill("/path/to/customer's profile");
    assert(
      (await page.locator("[data-setup-command]").textContent()).includes(
        "--claude-config-dir",
      ),
    );
    await scan.click();
    await page.waitForFunction(
      () =>
        !document.querySelector('[data-setup-form] [type="submit"]').disabled,
    );
    await page.screenshot({ path: `/tmp/clx-setup-recovery-${width}.png` });
    await page.unroute("**/api/setup");
    await page
      .getByRole("button", { name: "Retry connection", exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelector(".setup-recovery").hidden,
    );
    assert.equal(await scan.isEnabled(), true);
    await page.close();
    console.log(
      `${width}: old-server setup recovery, editable path and retry passed`,
    );
  }
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
}
