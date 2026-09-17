import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  stat,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPresets, mutatePresets, publicPresets } from "../src/store.mjs";
const catalog = {
  models: [{ id: "sonnet" }],
  families: [
    { id: "workflow@local", skills: [{ key: "plan" }, { key: "review" }] },
  ],
  mcpNames: ["docs"],
  otherPlugins: [{ id: "lsp" }],
};
const record = () => ({
  model: "sonnet",
  effort: "high",
  skillPlugins: { "workflow@local": { mode: "full" } },
  mcp: ["docs"],
  otherPlugins: [],
});
async function fixture(t, records = {}) {
  const dir = await mkdtemp(join(tmpdir(), "clx-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "presets.json");
  await writeFile(file, JSON.stringify(records));
  return { dir, file };
}
async function change(file, request) {
  return mutatePresets(
    file,
    { revision: (await readPresets(file)).revision, ...request },
    catalog,
  );
}
test("create, rename/edit, delete persist; prompts and extension fields survive updates", async (t) => {
  const { file, dir } = await fixture(t, {
    Original: { ...record(), prompt: "private-prompt", future: { keep: true } },
  });
  let snapshot = await change(file, {
    operation: "create",
    name: "New preset",
    record: record(),
  });
  assert.equal(
    snapshot.records["New preset"].skillPlugins["workflow@local"].mode,
    "full",
  );
  snapshot = await change(file, {
    operation: "update",
    previousName: "Original",
    name: "Renamed",
    record: {
      ...record(),
      skillPlugins: {
        "workflow@local": { mode: "subset", skills: ["review"] },
      },
    },
  });
  assert.equal(snapshot.records.Renamed.prompt, "private-prompt");
  assert.deepEqual(snapshot.records.Renamed.future, { keep: true });
  assert.equal(snapshot.records.Original, undefined);
  assert(
    !JSON.stringify(publicPresets(snapshot.records)).includes("private-prompt"),
  );
  await change(file, { operation: "delete", name: "New preset" });
  assert.deepEqual(Object.keys(JSON.parse(await readFile(file))), ["Renamed"]);
  assert.equal((await readdir(join(dir, ".preset-backups"))).length, 3);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});
test("stale revision and name collisions preserve bytes", async (t) => {
  const { file } = await fixture(t, { One: record() });
  const old = await readPresets(file);
  await change(file, { operation: "create", name: "Two", record: record() });
  const bytes = await readFile(file, "utf8");
  await assert.rejects(
    mutatePresets(
      file,
      { operation: "delete", name: "One", revision: old.revision },
      catalog,
    ),
    (e) => e.status === 409,
  );
  await assert.rejects(
    change(file, { operation: "create", name: "Two", record: record() }),
    (e) => e.status === 409,
  );
  assert.equal(await readFile(file, "utf8"), bytes);
});
test("reject invalid data, unknown skills and command-reserved names without writing", async (t) => {
  const { file } = await fixture(t);
  for (const name of [
    "",
    "ui",
    "prompts",
    "init",
    "--help",
    "__proto__",
    "bad\nname",
  ])
    await assert.rejects(
      change(file, { operation: "create", name, record: record() }),
    );
  for (const rec of [
    { ...record(), model: "unknown" },
    { ...record(), mcp: ["secret"] },
    { ...record(), prompt: "not editable" },
    {
      ...record(),
      skillPlugins: { "workflow@local": { mode: "subset", skills: ["ghost"] } },
    },
  ])
    await assert.rejects(
      change(file, { operation: "create", name: "Bad", record: rec }),
    );
  assert.deepEqual((await readPresets(file)).records, {});
});
test("existing unavailable references are preserved, and malformed JSON is never replaced", async (t) => {
  const existing = {
    ...record(),
    mcp: ["gone"],
    skillPlugins: {
      "missing@local": { mode: "full" },
      "workflow@local": { mode: "subset", skills: ["gone"] },
    },
  };
  const { file } = await fixture(t, { Old: existing });
  await change(file, {
    operation: "update",
    name: "Old",
    record: { ...existing, effort: "low" },
  });
  assert.equal((await readPresets(file)).records.Old.mcp[0], "gone");
  await writeFile(file, "{broken");
  await assert.rejects(readPresets(file), (e) => e.status === 422);
  assert.equal(await readFile(file, "utf8"), "{broken");
});
test("missing file can create its first preset; parallel saves cannot lose an update", async (t) => {
  const { file } = await fixture(t);
  await rm(file);
  const revision = (await readPresets(file)).revision;
  const attempts = await Promise.allSettled(
    ["One", "Two"].map((name) =>
      mutatePresets(
        file,
        { revision, operation: "create", name, record: record() },
        catalog,
      ),
    ),
  );
  assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(Object.keys((await readPresets(file)).records).length, 1);
});
