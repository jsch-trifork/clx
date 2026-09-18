import { chromium } from "playwright";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
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
const { server, url } = await startServer({
  catalogFile,
  presetsFile,
  onLaunch: async () => {},
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
    await page.goto(url);
    await page.locator(".overview-family").first().waitFor();
    assert.equal(await page.locator(".overview-node").count(), 92);
    await page.locator("[data-action=create]").click();
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
    await page.locator("[data-mode=full]").click();
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
    await page.locator("[data-action=settings]").click();
    await page.locator("[data-delete]").click();
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
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
}
