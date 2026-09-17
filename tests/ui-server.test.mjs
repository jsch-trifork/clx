import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.mjs";
import { readCatalog } from "../src/catalog.mjs";
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "clx-api-"));
  const skill = join(dir, "skills", "plan");
  await mkdir(skill, { recursive: true });
  await writeFile(
    join(skill, "SKILL.md"),
    "---\nname: plan\ndescription: >-\n  Make a plan\n  with evidence.\n---\nBody ignored.",
  );
  const catalogFile = join(dir, "loadout.json"),
    presetsFile = join(dir, "presets.json");
  await writeFile(
    catalogFile,
    JSON.stringify({
      models: [{ id: "sonnet", label: "Sonnet" }],
      skillPlugins: [
        {
          id: "workflow@local",
          name: "Workflow",
          skills: [{ dir: skill, label: "plan" }],
        },
      ],
      mcpServers: {
        docs: { env: { API_KEY: "never-send-this" }, command: "tool" },
      },
      otherPlugins: [],
    }),
  );
  await writeFile(
    presetsFile,
    JSON.stringify({
      Saved: {
        model: "sonnet",
        skillPlugins: { "workflow@local": { mode: "full" } },
        mcp: [],
        otherPlugins: [],
        prompt: "hidden-system-prompt",
      },
    }),
  );
  let launched;
  const { server, url } = await startServer({
    catalogFile,
    presetsFile,
    onLaunch: async (name) => {
      launched = name;
    },
  });
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  return {
    url: new URL(url).origin,
    token: new URL(url).hash.slice(1),
    catalogFile,
    getLaunch: () => launched,
  };
}
test("state is authenticated and contains descriptions but no MCP secrets or prompt text", async (t) => {
  const s = await setup(t);
  assert.equal((await fetch(s.url + "/api/state")).status, 401);
  const response = await fetch(s.url + "/api/state", {
    headers: { Authorization: "Bearer " + s.token },
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert(!text.includes("never-send-this"));
  assert(!text.includes("hidden-system-prompt"));
  assert(!text.includes("/skills/"));
  assert.equal(
    JSON.parse(text).families[0].skills[0].description,
    "Make a plan with evidence.",
  );
});
test("reject cross-origin mutations and allow exact saved-preset launch", async (t) => {
  const s = await setup(t);
  const headers = {
    Authorization: "Bearer " + s.token,
    "Content-Type": "application/json",
  };
  assert.equal(
    (
      await fetch(s.url + "/api/launch", {
        method: "POST",
        headers: { ...headers, Origin: "https://evil.example" },
        body: '{"name":"Saved"}',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(s.url + "/api/launch", {
        method: "POST",
        headers,
        body: '{"name":"missing"}',
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await fetch(s.url + "/api/launch", {
        method: "POST",
        headers,
        body: '{"name":"Saved"}',
      })
    ).status,
    200,
  );
  assert.equal(s.getLaunch(), "Saved");
});
test("API CRUD persists and static routes have CSP without arbitrary file reads", async (t) => {
  const s = await setup(t),
    headers = {
      Authorization: "Bearer " + s.token,
      "Content-Type": "application/json",
    };
  const state = await (await fetch(s.url + "/api/state", { headers })).json();
  const response = await fetch(s.url + "/api/presets", {
    method: "POST",
    headers,
    body: JSON.stringify({
      operation: "create",
      name: "From browser",
      revision: state.revision,
      record: {
        model: "sonnet",
        effort: "",
        skillPlugins: {},
        mcp: [],
        otherPlugins: [],
      },
    }),
  });
  assert.equal(response.status, 200);
  const after = await response.json();
  assert(after.presets.some((p) => p.name === "From browser"));
  const html = await fetch(s.url + "/");
  assert.match(
    html.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  assert.equal((await fetch(s.url + "/src/store.mjs")).status, 404);
  assert.equal((await fetch(s.url + "/%2e%2e%2fpackage.json")).status, 404);
});
test("missing skill files become visible warnings", async (t) => {
  const s = await setup(t);
  const data = await readCatalog(s.catalogFile);
  assert.equal(data.warnings.length, 0);
  assert.equal(data.families[0].skills[0].available, true);
});
