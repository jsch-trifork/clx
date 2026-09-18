import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { initializeCatalog, setupLocation } from "../src/setup.mjs";
import { startServer } from "../src/server.mjs";
const exec = promisify(execFile);

test("custom Claude profile is remembered, isolated, and passed to launched sessions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "clx-profile-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profile = join(dir, "work profile $(not-a-command)"),
    config = join(dir, "clx"),
    home = join(dir, "home");
  const plugin = join(profile, "plugins/cache/example/review/1");
  await mkdir(join(plugin, "skills/check"), { recursive: true });
  await mkdir(home);
  await writeFile(
    join(plugin, "skills/check/SKILL.md"),
    "---\nname: check\n---\n",
  );
  await writeFile(
    join(profile, "settings.json"),
    JSON.stringify({ enabledPlugins: { "review@example": true } }),
  );
  await writeFile(
    join(profile, ".claude.json"),
    JSON.stringify({ mcpServers: { work: { command: "example" } } }),
  );
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { wrong: { command: "wrong" } } }),
  );
  const env = { PATH: process.env.PATH, HOME: home, CLX_DIR: config };
  await exec(
    process.execPath,
    ["bin/clx.mjs", "init", "--claude-config-dir", profile],
    { env },
  );
  const catalog = join(config, "loadout.json");
  const data = JSON.parse(await readFile(catalog));
  assert.equal(data.claudeConfigDir, profile);
  assert.equal(
    data.skillPlugins[0].skills[0].dir,
    join(plugin, "skills/check"),
  );
  assert.deepEqual(Object.keys(data.mcpServers), ["work"]);
  await exec(process.execPath, ["bin/clx.mjs", "init", "--force"], { env });
  assert.equal(JSON.parse(await readFile(catalog)).claudeConfigDir, profile);
  assert.equal((await setupLocation(catalog)).directory, profile);
  await writeFile(
    join(config, "presets.json"),
    JSON.stringify({
      Work: { model: "sonnet", skillPlugins: {}, mcp: [], otherPlugins: [] },
    }),
  );
  // Replace only external preflight and Claude execution; exercise the real shell launcher.
  const script =
    'source "$1"; _clx_preflight() { return 0; }; claude() { print -r -- "$CLAUDE_CONFIG_DIR"; }; clx Work';
  const launched = await exec(
    "zsh",
    ["-c", script, "test", resolve("clx.zsh")],
    { env },
  );
  assert(launched.stdout.includes(profile));
  const before = await readFile(catalog, "utf8"),
    presets = await readFile(join(config, "presets.json"), "utf8");
  await assert.rejects(
    initializeCatalog(catalog, join(dir, "missing"), true),
    /does not exist/,
  );
  await writeFile(join(profile, "settings.json"), "bad json");
  await assert.rejects(initializeCatalog(catalog, profile, true));
  assert.equal(await readFile(catalog, "utf8"), before);
  assert.equal(await readFile(join(config, "presets.json"), "utf8"), presets);
});

test("CLAUDE_CONFIG_DIR is discovered and the default profile can be restored", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "clx-env-profile-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, "home"),
    profile = join(dir, "custom"),
    config = join(dir, "clx");
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(profile);
  await writeFile(
    join(home, ".claude.json"),
    '{"mcpServers":{"default":{"command":"example"}}}',
  );
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    CLX_DIR: config,
    CLAUDE_CONFIG_DIR: profile,
  };
  await exec(process.execPath, ["bin/clx.mjs", "init"], { env });
  const file = join(config, "loadout.json");
  assert.equal(JSON.parse(await readFile(file)).claudeConfigDir, profile);
  await exec(
    process.execPath,
    [
      "bin/clx.mjs",
      "init",
      "--force",
      "--claude-config-dir",
      join(home, ".claude"),
    ],
    { env },
  );
  const data = JSON.parse(await readFile(file));
  assert.equal(data.claudeConfigDir, join(home, ".claude"));
  assert.deepEqual(Object.keys(data.mcpServers), ["default"]);
});

test("folder setup requires authenticated same-origin requests and validates input", async (t) => {
  let calls = 0;
  const { server, url } = await startServer({
    catalogFile: "unused",
    presetsFile: "unused",
    onSetup: async (r) => {
      calls++;
      return { directory: r?.directory || "/example/profile" };
    },
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const endpoint = new URL("/api/setup", url),
    token = new URL(url).hash.slice(1);
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  assert.equal((await fetch(endpoint)).status, 401);
  assert.equal(
    (
      await fetch(endpoint, {
        method: "POST",
        headers: { ...headers, Origin: "https://example.com" },
        body: JSON.stringify({ directory: "/example" }),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(endpoint, {
        method: "POST",
        headers,
        body: '{"directory":[]}',
      })
    ).status,
    400,
  );
  assert.equal(calls, 0);
  assert.equal(
    (
      await fetch(endpoint, {
        method: "POST",
        headers,
        body: '{"directory":"/example/profile"}',
      })
    ).status,
    200,
  );
  assert.equal(calls, 1);
});
