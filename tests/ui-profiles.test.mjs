import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Profiles } from "../src/profiles.mjs";
import { compatibility, preserveUnavailable } from "../src/compatibility.mjs";
import { startServer } from "../src/server.mjs";
const exec = promisify(execFile);

test("profiles share presets, persist executable paths, and reject stale edits", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "clx-profiles-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const catalog = join(dir, "loadout.json"),
    presets = join(dir, "presets.json"),
    config = join(dir, "Customer config");
  await mkdir(config);
  await writeFile(join(config, "settings.json"), "{}");
  await writeFile(
    catalog,
    JSON.stringify({
      claudeConfigDir: config,
      models: [{ id: "sonnet" }],
      skillPlugins: [],
      otherPlugins: [],
      mcpServers: {},
    }),
  );
  const saved = JSON.stringify({
    Investigate: {
      model: "sonnet",
      skillPlugins: { "missing@customer": { mode: "full" } },
      mcp: [],
      otherPlugins: [],
    },
  });
  await writeFile(presets, saved);
  const executable = join(dir, "Claude binary");
  const output = join(dir, "launched.json");
  await writeFile(
    executable,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.TEST_OUTPUT,JSON.stringify({args:process.argv.slice(2),config:process.env.CLAUDE_CONFIG_DIR}));\n`,
  );
  await chmod(executable, 0o755);
  const p = new Profiles(dir, catalog);
  const initial = await p.list();
  assert.equal(initial.profiles[0].name, "Default");
  const state = await p.mutate({
    operation: "create",
    name: "Customer A",
    directory: config,
    executable,
    revision: initial.revision,
  });
  const customer = state.profiles.find((x) => x.name === "Customer A");
  assert.equal(state.profiles.length, 2);
  await assert.rejects(
    p.mutate({
      operation: "delete",
      id: customer.id,
      revision: initial.revision,
    }),
    /changed/,
  );
  await p.select(customer.id);
  assert.notEqual(p.catalog(), catalog);
  assert.equal((await p.current()).executable, executable);
  assert.equal(await readFile(presets, "utf8"), saved);
  const again = new Profiles(dir, catalog);
  await again.select("Customer A");
  assert.equal((await again.current()).directory, config);
  const fake = join(dir, "gum");
  await writeFile(fake, "#!/bin/sh\nexit 0\n");
  await chmod(fake, 0o755);
  await exec(
    process.execPath,
    ["bin/clx.mjs", "--profile", "Customer A", "Investigate"],
    {
      env: {
        PATH: dir + ":" + process.env.PATH,
        HOME: dir,
        CLX_DIR: dir,
        CLX_ALLOW_MISSING: "1",
        TEST_OUTPUT: output,
      },
    },
  );
  const launch = JSON.parse(await readFile(output));
  assert.equal(launch.config, config);
  assert(launch.args.includes("--model"));
  await assert.rejects(
    exec(process.execPath, ["bin/clx.mjs", "Investigate"], {
      env: { PATH: process.env.PATH, HOME: dir, CLX_DIR: dir },
    }),
    /Multiple Claude profiles/,
  );
  assert.equal(await readFile(presets, "utf8"), saved);
  await assert.rejects(
    p.mutate({
      operation: "delete",
      id: customer.id,
      revision: (await p.list()).revision,
    }),
    /Switch/,
  );
  await p.select("default");
  await p.mutate({
    operation: "delete",
    id: customer.id,
    revision: (await p.list()).revision,
  });
  assert.equal((await p.list()).profiles.length, 1);
});

test("compatibility lists unavailable selections and editing preserves them", () => {
  const catalog = {
    families: [{ id: "p", skills: [{ key: "yes", available: true }] }],
    mcpNames: [],
    otherPlugins: [],
  };
  const record = {
    model: "sonnet",
    skillPlugins: {
      p: { mode: "subset", skills: ["yes", "missing"] },
      q: { mode: "full" },
    },
    mcp: ["docs"],
    otherPlugins: ["extra"],
  };
  assert.deepEqual(compatibility(record, catalog), [
    "Skill: p/missing",
    "Plugin: q",
    "Plugin: extra",
    "Integration: docs",
  ]);
  const draft = { skillPlugins: {}, mcp: [], otherPlugins: [] };
  const kept = preserveUnavailable(draft, record, catalog);
  assert.deepEqual(kept.skillPlugins.p.skills, ["missing"]);
  assert.deepEqual(kept.skillPlugins.q, { mode: "full" });
  assert.deepEqual(kept.mcp, ["docs"]);
});

test("API launch requires explicit missing-item consent and the current profile", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "clx-profile-api-"));
  const catalog = join(dir, "loadout.json"),
    presets = join(dir, "presets.json");
  await writeFile(
    catalog,
    JSON.stringify({ models: [], skillPlugins: [], mcpServers: {} }),
  );
  await writeFile(
    presets,
    JSON.stringify({ Shared: { skillPlugins: { missing: { mode: "full" } } } }),
  );
  let launched = 0;
  const { server, url } = await startServer({
    catalogFile: catalog,
    presetsFile: presets,
    onProfiles: async () => ({ activeId: "default", profiles: [] }),
    onLaunch: async () => {
      launched++;
    },
  });
  t.after(async () => {
    await new Promise((r) => {
      server.close(r);
      server.closeAllConnections();
    });
    await rm(dir, { recursive: true, force: true });
  });
  const headers = {
    Authorization: `Bearer ${new URL(url).hash.slice(1)}`,
    "Content-Type": "application/json",
  };
  const send = (body) =>
    fetch(new URL("/api/launch", url), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  assert.equal(
    (await send({ name: "Shared", profileId: "wrong", allowMissing: true }))
      .status,
    409,
  );
  const blocked = await send({ name: "Shared", profileId: "default" });
  assert.deepEqual((await blocked.json()).missing, ["Plugin: missing"]);
  assert.equal(launched, 0);
  assert.equal(
    (await send({ name: "Shared", profileId: "default", allowMissing: true }))
      .status,
    200,
  );
  assert.equal(launched, 1);
});
