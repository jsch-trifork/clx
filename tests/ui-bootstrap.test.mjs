import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
test("fresh init is offline and contains only this user's discovered configuration", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "clx-first-run-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, "user"),
    config = join(dir, "config");
  await mkdir(home);
  const env = { PATH: process.env.PATH, HOME: home, CLX_DIR: config };
  await exec(process.execPath, ["bin/clx.mjs", "init"], { env });
  const file = join(config, "loadout.json");
  const initial = await readFile(file, "utf8");
  const data = JSON.parse(initial);
  assert.deepEqual(
    data.models.map((m) => m.id),
    ["sonnet", "opus", "haiku"],
  );
  assert.deepEqual(data.skillPlugins, []);
  assert.deepEqual(data.otherPlugins, []);
  assert.deepEqual(data.mcpServers, {});
  assert.equal((await stat(file)).mode & 0o077, 0);
  await assert.rejects(
    exec(process.execPath, ["bin/clx.mjs", "init"], { env }),
  );
  assert.equal(await readFile(file, "utf8"), initial);
  const root = join(home, ".claude/plugins/cache/example/workflow/1.0.0");
  await mkdir(join(root, "skills/review"), { recursive: true });
  await mkdir(join(root, ".claude-plugin"));
  await writeFile(
    join(root, "skills/review/SKILL.md"),
    "---\nname: review\ndescription: Synthetic review skill\n---\n",
  );
  await writeFile(
    join(root, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "workflow" }),
  );
  await writeFile(
    join(home, ".claude/settings.json"),
    JSON.stringify({ enabledPlugins: { "workflow@example": true } }),
  );
  // No installed_plugins.json: cache fallback must still discover the user's skill.
  await exec(process.execPath, ["bin/clx.mjs", "init", "--force"], { env });
  const discovered = JSON.parse(await readFile(file));
  assert.equal(
    discovered.skillPlugins[0].skills[0].dir,
    join(root, "skills/review"),
  );
  assert.equal(discovered.skillPlugins.length, 1);
});
