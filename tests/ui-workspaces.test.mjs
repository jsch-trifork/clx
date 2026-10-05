import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  resolveWorkspace,
  workspaceSettings,
  mergeSettings,
  projectSlug,
  checkEntry,
  saveWorkspace,
  renameWorkspace,
  deleteWorkspace,
} from "../src/workspaces.mjs";
const exec = promisify(execFile);

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "clx-ws-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const code = join(home, "code");
  for (const dir of ["org/present", "org/ui", "org/calendar", "dagsplan"])
    await mkdir(join(code, dir), { recursive: true });
  await writeFile(join(code, "org", "notes.md"), "");
  for (const dir of [".worktrees/other", ".ssh", ".nuget", "Downloads"])
    await mkdir(join(home, dir), { recursive: true });
  const claude = join(home, ".claude");
  for (const dir of ["plugins", "plans"])
    await mkdir(join(claude, dir), { recursive: true });
  for (const slug of [
    projectSlug(join(code, "org/present")),
    projectSlug(join(code, "dagsplan")),
  ])
    await mkdir(join(claude, "projects", slug), { recursive: true });
  const tmpRoot = join(home, "tmp-claude");
  for (const dir of [
    projectSlug(join(code, "org/present")),
    projectSlug(join(code, "dagsplan")),
  ])
    await mkdir(join(tmpRoot, dir), { recursive: true });
  const config = {
    fence: [],
    workspaces: {
      present: { start: "~/code/org/present", dirs: ["~/code/org/ui"] },
    },
  };
  const options = { home, claudeDir: claude, tmpRoot, guard: "/guard.mjs" };
  return { home, code, claude, tmpRoot, config, options };
}

const has = (deny, tool, path, dir = true) =>
  deny.includes(`${tool}(/${path}${dir ? "/**" : ""})`);

test("a workspace hides everything in the home folder except its own folders", async (t) => {
  const { home, code, claude, tmpRoot, config, options } = await fixture(t);
  const ws = resolveWorkspace(config, "present", home);
  assert.equal(ws.start, join(code, "org/present"));
  const settings = await workspaceSettings(ws, options);
  const deny = settings.permissions.deny;

  // Other projects, wherever they live in the home folder.
  for (const hidden of [
    "code/org/calendar",
    "code/dagsplan",
    ".worktrees",
    ".ssh",
    "Downloads",
  ]) {
    assert.ok(has(deny, "Read", join(home, hidden)), `read ${hidden}`);
    assert.ok(has(deny, "Edit", join(home, hidden)), `edit ${hidden}`);
  }
  assert.ok(
    has(deny, "Read", join(code, "org/notes.md"), false),
    "loose files are denied exactly",
  );
  for (const open of ["org/present", "org/ui"])
    assert.ok(!deny.some((r) => r.includes(join(code, open) + "/**")), open);

  // Other projects' history and scratch space; this workspace's own stay open.
  const other = projectSlug(join(code, "dagsplan"));
  const mine = projectSlug(join(code, "org/present"));
  assert.ok(has(deny, "Read", join(claude, "projects", other)));
  assert.ok(has(deny, "Read", join(tmpRoot, other)));
  assert.ok(!deny.some((r) => r.includes(mine)));
  // Shared plans are hidden; plans go in the project instead.
  assert.ok(has(deny, "Read", join(claude, "plans")));
  assert.equal(settings.plansDirectory, ".claude/plans");
  // Skills stay readable but not editable.
  assert.ok(!has(deny, "Read", join(claude, "plugins")));
  assert.ok(has(deny, "Edit", join(claude, "plugins")));

  // Claude can't rewrite its own limits or add unsandboxed code.
  for (const path of [
    ".claude/settings.local.json",
    ".claude/hooks",
    ".mcp.json",
    ".git/hooks",
  ]) {
    assert.ok(deny.includes(`Edit(/${join(code, "org/present", path)})`), path);
    assert.ok(deny.includes(`Edit(/${join(code, "org/ui", path)}/**)`), path);
  }

  // Tools that act outside the sandbox.
  for (const tool of [
    "mcp__claude-in-chrome",
    "RemoteTrigger",
    "SendMessage",
    "ListAgents",
    "WebFetch",
  ])
    assert.ok(deny.includes(tool), tool);
  assert.deepEqual(settings.hooks.PreToolUse, [
    {
      matcher: "Agent",
      hooks: [{ type: "command", command: 'node "/guard.mjs"' }],
    },
  ]);

  assert.deepEqual(settings.permissions.additionalDirectories, [
    join(code, "org/ui"),
  ]);
  assert.equal(settings.sandbox.enabled, true);
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(settings.sandbox.filesystem.denyRead, [home, tmpRoot]);
  const allowRead = settings.sandbox.filesystem.allowRead;
  for (const open of [
    join(code, "org/present"),
    join(home, ".nuget"),
    join(claude, "plugins"),
  ])
    assert.ok(allowRead.includes(open), open);
  assert.ok(!allowRead.includes(join(home, ".ssh")));
  // Common toolchains are readable; ~/.android holds adb keys, so only the SDK is.
  for (const tool of [
    ".pyenv",
    "go",
    ".asdf",
    ".deno",
    ".conda",
    "Library/Android",
  ])
    assert.ok(allowRead.includes(join(home, tool)), tool);
  assert.ok(!allowRead.includes(join(home, ".android")));
  assert.equal(settings.env.DOTNET_CLI_HOME, home);
  assert.ok(
    settings.sandbox.filesystem.allowWrite.includes("/private/tmp/.dotnet"),
  );
  assert.deepEqual(settings.sandbox.network.allowedDomains, []);
  // Auto mode can't widen access per command, and GitHub is hard-denied.
  assert.equal(settings.sandbox.network.strictAllowlist, true);
  assert.deepEqual(settings.sandbox.network.deniedDomains, [
    "github.com",
    "*.github.com",
    "*.githubusercontent.com",
  ]);
  assert.equal(settings.sandbox.enableWeakerNetworkIsolation, undefined);
});

test("opt-ins: GitHub, WebFetch, extra network and extra readable paths", async (t) => {
  const { home, config, options } = await fixture(t);
  Object.assign(config.workspaces.present, {
    github: true,
    web: true,
    network: ["registry.npmjs.org"],
    allowRead: ["~/.docker"],
    mcp: ["context7"],
  });
  const ws = resolveWorkspace(config, "present", home);
  assert.deepEqual(ws.mcp, ["context7"]);
  const settings = await workspaceSettings(ws, options);
  assert.deepEqual(settings.sandbox.network.allowedDomains, [
    "registry.npmjs.org",
    "github.com",
    "api.github.com",
    "*.githubusercontent.com",
  ]);
  assert.equal(settings.sandbox.enableWeakerNetworkIsolation, true);
  assert.equal(settings.sandbox.network.strictAllowlist, true);
  assert.equal(settings.sandbox.network.deniedDomains, undefined);
  assert.ok(!settings.permissions.deny.includes("WebFetch"));
  assert.ok(
    settings.sandbox.filesystem.allowRead.includes(join(home, ".docker")),
  );
});

test("with Chrome on, only the browser block is lifted", async (t) => {
  const { home, config, options } = await fixture(t);
  const ws = resolveWorkspace(config, "present", home);
  assert.equal(ws.chrome, false);
  ws.chrome = true;
  const deny = (await workspaceSettings(ws, options)).permissions.deny;
  assert.ok(!deny.includes("mcp__claude-in-chrome"));
  for (const tool of ["RemoteTrigger", "SendMessage", "ListAgents", "WebFetch"])
    assert.ok(deny.includes(tool), tool);
});

test("protected paths and extra fence roots are denied", async (t) => {
  const { home, config, options } = await fixture(t);
  const drive = await mkdtemp(join(tmpdir(), "clx-drive-"));
  t.after(() => rm(drive, { recursive: true, force: true }));
  await mkdir(join(drive, "repo"));
  config.fence = [drive];
  const settings = await workspaceSettings(
    resolveWorkspace(config, "present", home),
    {
      ...options,
      protect: ["/tmp/clx-settings-abc"],
    },
  );
  assert.ok(settings.permissions.deny.includes("Edit(//tmp/clx-settings-abc)"));
  assert.ok(has(settings.permissions.deny, "Read", drive));
  assert.ok(settings.sandbox.filesystem.denyRead.includes(drive));
});

test("clear errors for unknown workspaces and missing folders", async (t) => {
  const { home, config, options } = await fixture(t);
  assert.throws(
    () => resolveWorkspace(config, "nope", home),
    /No workspace named 'nope'/,
  );
  config.workspaces.present.dirs = ["~/code/missing"];
  await assert.rejects(
    workspaceSettings(resolveWorkspace(config, "present", home), options),
    /Workspace folder not found/,
  );
});

test("merging keeps the user's own rules and settings", () => {
  const merged = mergeSettings(
    {
      permissions: { deny: ["Bash(rm:*)"], allow: ["Bash(ls:*)"] },
      enabledPlugins: { a: true },
    },
    {
      permissions: { deny: ["Read(//x/**)"], additionalDirectories: ["/y"] },
      sandbox: { enabled: true },
    },
  );
  assert.deepEqual(merged, {
    permissions: {
      deny: ["Bash(rm:*)", "Read(//x/**)"],
      allow: ["Bash(ls:*)"],
      additionalDirectories: ["/y"],
    },
    enabledPlugins: { a: true },
    sandbox: { enabled: true },
  });
});

test("the helper script lists, filters MCP and applies a workspace", async (t) => {
  const { home, code, config } = await fixture(t);
  config.workspaces.present.mcp = ["context7"];
  const file = join(home, "workspaces.json"),
    settings = join(home, "settings.json");
  await writeFile(file, JSON.stringify(config));
  await writeFile(
    settings,
    JSON.stringify({
      enabledPlugins: { a: true },
      sandbox: { excludedCommands: ["docker"] },
    }),
  );
  const script = new URL("../scripts/workspace.mjs", import.meta.url).pathname;
  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
  };

  assert.equal(
    (await exec("node", [script, "list", file], { env })).stdout,
    "present\n",
  );
  assert.equal(
    (await exec("node", [script, "mcp", file, "present"], { env })).stdout,
    "context7\n",
  );
  const { stdout } = await exec(
    "node",
    [script, "apply", file, "present", settings, "/tmp/clx-mcp-x"],
    { env },
  );
  assert.equal(
    stdout,
    `${join(code, "org/present")}\n${join(code, "org/ui")}\n`,
  );
  const written = JSON.parse(await readFile(settings, "utf8"));
  assert.deepEqual(written.enabledPlugins, { a: true });
  assert.equal(written.sandbox.enabled, true);
  // The user's unsandboxed command list is emptied, not merged.
  assert.deepEqual(written.sandbox.excludedCommands, []);
  assert.ok(written.permissions.deny.includes(`Edit(/${settings})`));
  assert.ok(written.permissions.deny.includes("Edit(//tmp/clx-mcp-x)"));
  assert.match(
    written.hooks.PreToolUse[0].hooks[0].command,
    /workspace-guard\.mjs"$/,
  );

  await assert.rejects(
    exec("node", [script, "apply", file, "nope", settings], { env }),
    /No workspace/,
  );
});

function runGuard(input) {
  const guard = new URL("../scripts/workspace-guard.mjs", import.meta.url)
    .pathname;
  return new Promise((done) => {
    const child = spawn("node", [guard]);
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => done({ code, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

test("the guard hook blocks cloud agents and lets local ones run", async () => {
  const remote = await runGuard({
    tool_name: "Agent",
    tool_input: { prompt: "x", isolation: "remote" },
  });
  assert.equal(remote.code, 2);
  assert.match(remote.stderr, /remote \(cloud\) agents are blocked/);
  assert.equal(
    (await runGuard({ tool_name: "Agent", tool_input: { prompt: "x" } })).code,
    0,
  );
  assert.equal(
    (
      await runGuard({
        tool_name: "Agent",
        tool_input: { isolation: "worktree" },
      })
    ).code,
    0,
  );
});

test("saving checks entries, stores ~ paths and keeps other settings", async (t) => {
  const { home, code } = await fixture(t);
  const file = join(home, "ws", "workspaces.json");
  await saveWorkspace(
    file,
    "present",
    {
      start: join(code, "org/present"),
      dirs: ["~/code/org/ui"],
      mcp: ["context7"],
    },
    home,
  );
  await saveWorkspace(
    file,
    "dags",
    { start: "~/code/dagsplan", github: true },
    home,
  );
  const data = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(data.workspaces.present, {
    start: "~/code/org/present",
    dirs: ["~/code/org/ui"],
    mcp: ["context7"],
  });
  assert.equal(data.workspaces.dags.github, true);

  const refuse = (entry, message) =>
    assert.rejects(checkEntry(entry, home), message);
  await refuse({ dirs: [] }, /needs a "start" folder/);
  await refuse({ start: "~/code/missing" }, /Folder not found/);
  await refuse(
    { start: "~/code/dagsplan", dirs: ["~/nope"] },
    /Folder not found/,
  );
  // A typo must not silently leave the workspace weaker than intended.
  await refuse(
    { start: "~/code/dagsplan", chrome: true },
    /Unknown workspace setting 'chrome'/,
  );
  await refuse({ start: "~/code/dagsplan", github: "yes" }, /true or false/);
  await refuse(
    { start: "~/code/dagsplan", mcp: "context7" },
    /list of strings/,
  );
  await assert.rejects(
    saveWorkspace(file, "has space", { start: "~/code/dagsplan" }, home),
    /without spaces/,
  );
});

test("renaming keeps order and refuses clashes; deleting removes only the entry", async (t) => {
  const { home, code } = await fixture(t);
  const file = join(home, "workspaces.json");
  await writeFile(
    file,
    JSON.stringify({
      fence: ["/Volumes/code"],
      workspaces: {
        a: { start: "~/code/dagsplan" },
        b: { start: "~/code/org/ui" },
      },
    }),
  );
  await renameWorkspace(file, "a", "alpha");
  let data = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(Object.keys(data.workspaces), ["alpha", "b"]);
  await assert.rejects(renameWorkspace(file, "alpha", "b"), /already exists/);
  await assert.rejects(
    renameWorkspace(file, "nope", "x"),
    /No workspace named 'nope'/,
  );
  await deleteWorkspace(file, "alpha");
  data = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(Object.keys(data.workspaces), ["b"]);
  assert.deepEqual(data.fence, ["/Volumes/code"]);
  assert.ok(
    await exec("test", ["-d", join(code, "dagsplan")]),
    "folders are untouched",
  );
});
