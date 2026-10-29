import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  allowed,
  isPrivate,
  serverName,
  startProxy,
} from "../scripts/egress-proxy.mjs";
import {
  planMounts,
  claudeRunArgs,
  rebaseState,
  sweepRebaseState,
  gitWatch,
} from "../src/docker.mjs";
import { checkEntry, resolveWorkspace } from "../src/workspaces.mjs";
import { symlink, rename, readFile } from "node:fs/promises";

const exec = promisify(execFile);

// ---- egress proxy: the pure allow/deny helpers ----

test("allowed: exact host, wildcard subdomains only, case- and dot-insensitive", () => {
  const pats = ["api.anthropic.com", "*.githubusercontent.com"];
  assert.equal(allowed("api.anthropic.com", pats), true);
  assert.equal(allowed("API.ANTHROPIC.COM", pats), true, "case folds");
  // A wildcard covers subdomains but not the bare apex.
  assert.equal(allowed("raw.githubusercontent.com", pats), true);
  assert.equal(allowed("githubusercontent.com", pats), false);
  // No substring/suffix confusion with a lookalike domain.
  assert.equal(allowed("evilgithubusercontent.com", pats), false);
  assert.equal(allowed("api.anthropic.com.evil.net", pats), false);
  assert.equal(allowed("notanthropic.com", pats), false);
});

test("isPrivate: loopback, RFC1918, link-local, CGNAT, Docker host and mapped v6", () => {
  for (const addr of [
    "127.0.0.1",
    "10.0.0.1",
    "192.168.65.2", // Docker Desktop host
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // CGNAT
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1", // v4-mapped loopback
    "::ffff:192.168.0.1",
    "0.0.0.0",
  ])
    assert.equal(isPrivate(addr), true, `${addr} must be private`);
  for (const addr of [
    "8.8.8.8",
    "1.1.1.1",
    "2606:4700::1111",
    "::ffff:8.8.8.8",
  ])
    assert.equal(isPrivate(addr), false, `${addr} must be public`);
});

test("serverName: reads the SNI host_name from a TLS ClientHello", () => {
  // A minimal ClientHello carrying one server_name extension.
  const name = Buffer.from("example.com", "ascii");
  const ext = Buffer.concat([
    Buffer.from([0x00, 0x00]), // extension type 0 (server_name)
    be16(name.length + 5),
    be16(name.length + 3), // server_name_list length
    Buffer.from([0x00]), // name_type host_name
    be16(name.length),
    name,
  ]);
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]), // client_version
    Buffer.alloc(32), // random
    Buffer.from([0x00]), // session id length
    be16(2),
    Buffer.from([0x00, 0x00]), // cipher suites
    Buffer.from([0x01, 0x00]), // compression methods
    be16(ext.length),
    ext,
  ]);
  const hs = Buffer.concat([
    Buffer.from([0x01]), // handshake type client_hello
    be24(body.length),
    body,
  ]);
  const record = Buffer.concat([
    Buffer.from([0x16, 0x03, 0x01]), // handshake, TLS 1.0 record
    be16(hs.length),
    hs,
  ]);
  assert.equal(serverName(record), "example.com");
  assert.equal(serverName(Buffer.from([0x17, 0x03, 0x03, 0, 0])), null);
});

function be16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}
function be24(n) {
  return Buffer.from([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
}

// ---- egress proxy: end-to-end CONNECT decisions ----

test("the proxy refuses everything outside the allow rules", async (t) => {
  const blocked = [];
  // Allow a host that resolves to loopback, so the DNS-rebinding guard can be
  // exercised end to end with real resolution and no mocks.
  const proxy = startProxy(["localhost", "api.anthropic.com"], 0, (l) =>
    blocked.push(l),
  );
  await listen(proxy, 0, "127.0.0.1");
  const port = proxy.address().port;
  t.after(() => proxy.close());

  // A host not on the list is refused before any lookup.
  assert.equal(status(await probe(port, "evil.test:443")), 403);
  // A literal IP address is refused (no name to match a TLS server name against).
  assert.equal(status(await probe(port, "10.0.0.1:443")), 403);
  // Anything but HTTPS on 443 is refused.
  assert.equal(status(await probe(port, "api.anthropic.com:80")), 403);
  // Plain HTTP (no CONNECT) is refused by the request handler.
  assert.equal(status(await probe(port, null)), 403);
  // DNS rebinding: an allowed name resolving to a private/loopback address is
  // refused, so it can never reach the Mac or another container.
  assert.equal(status(await probe(port, "localhost:443")), 403);

  assert.ok(blocked.some((l) => l.includes("not in the list")));
  assert.ok(blocked.some((l) => l.includes("IP address")));
  assert.ok(blocked.some((l) => l.includes("only port 443")));
  assert.ok(blocked.some((l) => l.includes("plain HTTP")));
  assert.ok(
    blocked.some((l) => l.includes("localhost") && l.includes("private")),
    "loopback resolution is blocked as a rebinding attempt",
  );
});

function listen(server, port, host) {
  return new Promise((done) => server.listen(port, host, done));
}

const status = (line) => Number(/\s(\d{3})\s/.exec(line)?.[1]);

// Drives one request through the proxy and returns its HTTP status line. A null
// target sends a plain (non-CONNECT) HTTP request instead.
function probe(port, target) {
  return new Promise((done) => {
    const s = net.connect(port, "127.0.0.1");
    let buf = "";
    const finish = (v) => {
      s.destroy();
      done(v);
    };
    const timer = setTimeout(() => finish("HTTP/1.1 000 timeout"), 8000);
    s.on("data", (d) => {
      buf += d;
      if (buf.includes("\r\n")) {
        clearTimeout(timer);
        finish(buf.split("\r\n")[0]);
      }
    });
    s.on("error", () => finish("HTTP/1.1 000 error"));
    if (target)
      s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    else s.write("GET http://evil.test/ HTTP/1.1\r\nHost: evil.test\r\n\r\n");
  });
}

// ---- mount plan ----

async function repoFixture(t) {
  const made = await mkdtemp(join(tmpdir(), "clx-docker-"));
  t.after(() => rm(made, { recursive: true, force: true }));
  const root = await realpath(made);
  const g = (cwd, ...args) =>
    exec("git", ["-C", cwd, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    });
  return { root, g };
}

const mode = (plan, path) =>
  plan.mounts.find((m) => m.path === path)?.mode ?? null;

test("planMounts protects editor/config files and the repo's own git controls", async (t) => {
  const { root, g } = await repoFixture(t);
  const app = join(root, "app");
  await mkdir(join(app, ".claude"), { recursive: true });
  await mkdir(join(app, ".vscode"), { recursive: true });
  await writeFile(join(app, ".envrc"), "export X=1");
  await g(root, "init", "-q", "app");
  await writeFile(join(app, "README.md"), "hi");
  await g(app, "add", "-A");
  await g(app, "commit", "-qm", "init");

  const plan = await planMounts([app]);
  assert.equal(mode(plan, app), "rw", "the workspace folder is writable");
  assert.equal(mode(plan, join(app, ".claude")), "ro");
  assert.equal(mode(plan, join(app, ".vscode")), "ro");
  assert.equal(mode(plan, join(app, ".envrc")), "ro");
  // The clone's own .git is the git dir, kept writable, but its controls are not.
  assert.equal(mode(plan, join(app, ".git")), "rw");
  assert.equal(mode(plan, join(app, ".git/config")), "ro");
  assert.equal(mode(plan, join(app, ".git/hooks")), "ro");
  assert.deepEqual(plan.gitDirs, [join(app, ".git")]);
});

test("planMounts stands in for a missing config.worktree, read-only", async (t) => {
  const { root, g } = await repoFixture(t);
  const app = join(root, "app");
  await g(root, "init", "-q", "app");
  await writeFile(join(app, "f"), "x");
  await g(app, "add", "-A");
  await g(app, "commit", "-qm", "i");
  // Valid config that makes git honour a per-worktree config file once present.
  await g(app, "config", "extensions.worktreeConfig", "true");

  const plan = await planMounts([app]);
  // The file does not exist, so it must get an empty read-only stand-in, not be left
  // writable inside the rw .git mount.
  assert.equal(mode(plan, join(app, ".git/config.worktree")), "empty-file");
});

test("planMounts protects a repo nested inside a workspace folder", async (t) => {
  const { root, g } = await repoFixture(t);
  const parent = join(root, "parent");
  const svc = join(parent, "svc");
  await mkdir(join(svc, ".vscode"), { recursive: true });
  await g(root, "init", "-q", "parent/svc");
  await writeFile(join(svc, "a"), "x");
  await g(svc, "add", "-A");
  await g(svc, "commit", "-qm", "i");

  // The workspace opens `parent`, which is not itself a repo.
  const plan = await planMounts([parent]);
  assert.equal(mode(plan, join(svc, ".git/hooks")), "ro", "nested hooks ro");
  assert.equal(mode(plan, join(svc, ".git/config")), "ro", "nested config ro");
  assert.equal(mode(plan, join(svc, ".vscode")), "ro", "nested editor dir ro");
  assert.ok(plan.gitDirs.includes(join(svc, ".git")));
});

test("planMounts follows a submodule's real git dir under .git/modules", async (t) => {
  const { root, g } = await repoFixture(t);
  const lib = join(root, "lib");
  const app = join(root, "app");
  await g(root, "init", "-q", "lib");
  await writeFile(join(lib, "l"), "x");
  await g(lib, "add", "-A");
  await g(lib, "commit", "-qm", "l");
  await g(root, "init", "-q", "app");
  await writeFile(join(app, "a"), "x");
  await g(app, "add", "-A");
  await g(app, "commit", "-qm", "i");
  // A submodule in a namespace path: its git dir is .git/modules/vendor/lib.
  await g(
    app,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "-q",
    "--name",
    "vendor/lib",
    "../lib",
    "vendor/lib",
  );
  await g(app, "commit", "-qm", "sub");

  const plan = await planMounts([app]);
  const modGit = join(app, ".git/modules/vendor/lib");
  // The namespace folder stays read-only; the real submodule git dir is found and its
  // controls protected, not left writable.
  assert.equal(mode(plan, join(app, ".git/modules")), "ro");
  assert.equal(mode(plan, join(modGit, "config")), "ro");
  assert.equal(mode(plan, join(modGit, "hooks")), "ro");
  assert.ok(
    plan.gitDirs.includes(modGit),
    "the watcher tracks the real submodule git dir",
  );
  // The submodule working-tree .git pointer file is read-only, so it can't be
  // redirected to another admin dir.
  assert.equal(mode(plan, join(app, "vendor/lib/.git")), "ro");
});

test("planMounts refuses a repo whose hooks path is a writable folder", async (t) => {
  const { root, g } = await repoFixture(t);
  const app = join(root, "app");
  await g(root, "init", "-q", "app");
  await writeFile(join(app, "f"), "x");
  await g(app, "add", "-A");
  await g(app, "commit", "-qm", "i");
  // core.hooksPath "." makes the repo root itself the hooks dir, which is rw.
  await g(app, "config", "core.hooksPath", ".");
  await assert.rejects(planMounts([app]), /hooks.*can't be protected/i);
});

// ---- docker run arguments ----

test("claudeRunArgs locks the container down and binds mounts by mode", () => {
  const plan = {
    mounts: [
      { path: "/w/app", mode: "rw" },
      { path: "/w/app/.git/config", mode: "ro" },
      { path: "/w/app/.idea", mode: "empty-dir" },
      { path: "/w/app/.mcp.json", mode: "empty-file" },
    ],
    gitDirs: [],
  };
  const args = claudeRunArgs({
    id: "clx-x",
    image: "img",
    network: "clx-x-net",
    user: "501:20",
    home: "/Users/me",
    homeVolume: "clx-home-x",
    start: "/w/app",
    plan,
    readOnly: ["/ro/scripts"],
    standIn: "/tmp/empty",
    env: { HOME: "/Users/me", TOKEN: undefined },
    tty: false,
    claudeArgs: ["--model", "x"],
  });
  const s = args.join(" ");
  assert.ok(s.includes("--cap-drop ALL"));
  assert.ok(s.includes("--security-opt no-new-privileges"));
  assert.ok(s.includes("--security-opt seccomp=builtin"));
  assert.ok(s.includes("--read-only"));
  assert.ok(s.includes("--network clx-x-net"));
  assert.ok(s.includes("--user 501:20"));
  // The workspace folder is bound rw; a protected file is bound readonly.
  assert.ok(s.includes("type=bind,src=/w/app,dst=/w/app "));
  assert.ok(
    s.includes(
      "type=bind,src=/w/app/.git/config,dst=/w/app/.git/config,readonly",
    ),
  );
  // A missing dir becomes a root-owned read-only tmpfs; a missing file a readonly bind.
  assert.ok(s.includes("type=tmpfs,dst=/w/app/.idea,tmpfs-mode=0555"));
  assert.ok(
    s.includes("type=bind,src=/tmp/empty,dst=/w/app/.mcp.json,readonly"),
  );
  // A read-only extra path is bound readonly.
  assert.ok(s.includes("type=bind,src=/ro/scripts,dst=/ro/scripts,readonly"));
  // A name-only env var (undefined value) is passed without its value.
  assert.ok(s.includes("-e TOKEN") && !s.includes("TOKEN="));
  // The claude command and its args come last, after the image.
  assert.ok(s.endsWith("img claude --model x"));
});

// ---- workspace settings: docker and image ----

test("checkEntry accepts docker:boolean and image:string, rejects bad types", async () => {
  const home = await mkdtemp(join(tmpdir(), "clx-ck-"));
  const start = join(home, "code");
  await mkdir(start, { recursive: true });
  const ok = await checkEntry(
    { start: "~/code", docker: true, image: "x:1" },
    home,
  );
  assert.equal(ok.docker, true);
  assert.equal(ok.image, "x:1");
  await assert.rejects(
    checkEntry({ start: "~/code", docker: "yes" }, home),
    /true or false/,
  );
  await assert.rejects(
    checkEntry({ start: "~/code", image: 7 }, home),
    /text value/,
  );
  await assert.rejects(
    checkEntry({ start: "~/code", image: "" }, home),
    /text value/,
  );
  await rm(home, { recursive: true, force: true });
});

test("resolveWorkspace defaults docker off and carries image through", () => {
  const home = "/Users/me";
  const off = resolveWorkspace(
    { fence: [], workspaces: { a: { start: "~/code" } } },
    "a",
    home,
  );
  assert.equal(off.docker, false);
  assert.equal(off.image, undefined);
  const on = resolveWorkspace(
    {
      fence: [],
      workspaces: { a: { start: "~/code", docker: true, image: "img:2" } },
    },
    "a",
    home,
  );
  assert.equal(on.docker, true);
  assert.equal(on.image, "img:2");
});

// ---- the extra bypasses the adversarial pass found ----

test("planMounts follows a .git symlink to the real git dir", async (t) => {
  const { root, g } = await repoFixture(t);
  const real = join(root, "real");
  const evil = join(root, "ws/evil");
  await g(root, "init", "-q", "real");
  await writeFile(join(real, "a"), "x");
  await g(real, "add", "-A");
  await g(real, "commit", "-qm", "i");
  // A planted repo whose .git is a symlink to a directory, not a dir or gitlink file.
  await mkdir(evil, { recursive: true });
  await rename(join(real, ".git"), join(evil, "realgitdir"));
  await symlink("realgitdir", join(evil, ".git"));

  const plan = await planMounts([join(root, "ws")]);
  // The symlink target's controls must be protected, not left writable.
  assert.equal(mode(plan, join(evil, "realgitdir/config")), "ro");
  assert.equal(mode(plan, join(evil, "realgitdir/hooks")), "ro");
  assert.ok(plan.gitDirs.includes(join(evil, "realgitdir")));
});

test("planMounts refuses a cross-folder core.hooksPath in either order", async (t) => {
  const { root, g } = await repoFixture(t);
  const a = join(root, "a");
  const b = join(root, "b");
  await g(root, "init", "-q", "a");
  await g(root, "init", "-q", "b");
  // Repo a points its hooks at the other workspace folder b, which is writable.
  await g(a, "config", "core.hooksPath", b);
  await assert.rejects(planMounts([a, b]), /hooks can't be protected/);
  await assert.rejects(planMounts([b, a]), /hooks can't be protected/);
});

test("sweepRebaseState removes state that appeared, keeps what was there before", async (t) => {
  const { root, g } = await repoFixture(t);
  const app = join(root, "app");
  await g(root, "init", "-q", "app");
  await writeFile(join(app, "f"), "x");
  await g(app, "add", "-A");
  await g(app, "commit", "-qm", "i");
  const gitDirs = [join(app, ".git")];

  // A rebase already in progress before the session is the user's own.
  await mkdir(join(app, ".git/rebase-apply"), { recursive: true });
  const before = await rebaseState(gitDirs);
  // The session then plants an exec-bearing interactive rebase.
  await mkdir(join(app, ".git/rebase-merge"), { recursive: true });
  await writeFile(
    join(app, ".git/rebase-merge/git-rebase-todo"),
    "exec touch /tmp/pwned\n",
  );

  const removed = await sweepRebaseState(gitDirs, before);
  assert.equal(removed.length, 1, "only the new state");
  assert.equal(removed[0].path, join(app, ".git/rebase-merge"));
  // The pre-existing rebase-apply is untouched; the planted rebase-merge is gone.
  const after = await rebaseState(gitDirs);
  assert.ok(after.has(join(app, ".git/rebase-apply")));
  assert.ok(!after.has(join(app, ".git/rebase-merge")));
});

test("planMounts protects a linked worktree's admin folder (the motivating case)", async (t) => {
  const { root, g } = await repoFixture(t);
  const main = join(root, "main");
  const wt = join(root, "wt");
  await g(root, "init", "-q", "main");
  await writeFile(join(main, "f"), "x");
  await g(main, "add", "-A");
  await g(main, "commit", "-qm", "i");
  await g(main, "worktree", "add", "-q", wt, "-b", "feature");

  // The workspace opens the linked worktree only.
  const plan = await planMounts([wt]);
  const admin = join(main, ".git/worktrees/wt");
  // The worktree's gitlink file and the admin folder's commondir/gitdir are read-only,
  // so the session can't repoint the worktree; the common repo's hooks and config are
  // read-only too. (The admin folder has no hooks of its own; they live in the common
  // .git/hooks, which is protected below.)
  assert.equal(mode(plan, join(wt, ".git")), "ro");
  assert.equal(mode(plan, join(admin, "commondir")), "ro");
  assert.equal(mode(plan, join(admin, "gitdir")), "ro");
  assert.equal(mode(plan, join(main, ".git/hooks")), "ro");
  assert.equal(mode(plan, join(main, ".git/config")), "ro");
  // The shared common git dir is mounted so git still works, and both git dirs are
  // watched for a commondir redirect.
  assert.ok(plan.gitDirs.includes(join(main, ".git")));
  assert.ok(plan.gitDirs.includes(admin));
});

test("gitWatch.check removes a commondir that appears where there was none", async (t) => {
  const { root, g } = await repoFixture(t);
  const app = join(root, "app");
  await g(root, "init", "-q", "app");
  await writeFile(join(app, "f"), "x");
  await g(app, "add", "-A");
  await g(app, "commit", "-qm", "i");
  const gitDir = join(app, ".git");

  let notified = null;
  const watcher = await gitWatch([gitDir], (found) => {
    notified = found;
  });
  t.after(() => watcher.close());
  // A plain clone's .git has no commondir; the session plants one pointing elsewhere.
  await writeFile(join(gitDir, "commondir"), "/tmp/attacker\n");
  const found = await watcher.check();
  assert.deepEqual(found, [join(gitDir, "commondir")]);
  // It is removed, so host git can't be redirected to another config/hooks.
  await assert.rejects(readFile(join(gitDir, "commondir")), /ENOENT/);
});

test("sweepRebaseState reports the branch to return to", async (t) => {
  const { root, g } = await repoFixture(t);
  const app = join(root, "app");
  await g(root, "init", "-q", "app");
  await writeFile(join(app, "f"), "x");
  await g(app, "add", "-A");
  await g(app, "commit", "-qm", "i");
  const gitDirs = [join(app, ".git")];
  const before = await rebaseState(gitDirs);
  await mkdir(join(app, ".git/rebase-merge"), { recursive: true });
  await writeFile(
    join(app, ".git/rebase-merge/head-name"),
    "refs/heads/main\n",
  );

  const removed = await sweepRebaseState(gitDirs, before);
  assert.equal(
    removed[0].branch,
    "main",
    "the branch name is read before deleting",
  );
});
