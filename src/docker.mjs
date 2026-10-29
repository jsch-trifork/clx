import { execFile } from "node:child_process";
import { watch } from "node:fs";
import { lstat, readdir, realpath, rm, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

// A docker workspace runs Claude Code in a container that holds only the workspace
// folders. Its network is internal (no route out, no DNS); the only thing it can reach
// is clx's egress proxy, which forwards HTTPS to the allowed domains. What stays in
// the folders afterwards is what you run later on the Mac, so the files that make
// git, Claude Code or an editor run code on their own are mounted read-only.

const run = promisify(execFile);

// Domains Claude Code itself needs from inside the container.
export const CLAUDE_DOMAINS = ["api.anthropic.com"];

// Per folder: files and folders the Mac acts on without you deciding to run them.
const FOLDER_DIRS = [".claude", ".vscode", ".idea", ".husky", ".devcontainer"];
const FOLDER_FILES = [".mcp.json", ".envrc", ".git"];

const within = (path, root) => path === root || path.startsWith(root + sep);

async function kind(path) {
  try {
    const s = await lstat(path);
    return s.isDirectory() ? "dir" : "file";
  } catch {
    return null;
  }
}

async function git(dir, ...args) {
  try {
    return (await run("git", ["-C", dir, ...args])).stdout.trim();
  } catch {
    return "";
  }
}

// A git folder's own control files: what git reads to decide which config, hooks
// and object store to use. `commondir` and `gitdir` exist only in worktree admin
// folders; a missing one can't get a stand-in (git refuses an empty commondir), so
// docker-run watches for it instead (see gitWatch).
const GIT_FILES = ["config", "config.worktree", "commondir", "gitdir"];

// Plans every mount for the workspace folders, parents before children.
//   rw          a workspace folder, a git folder outside them, or a folder bound onto
//               itself so it can't be renamed away and replaced (rename fails on a
//               mount point)
//   ro          an existing file or folder the Mac acts on by itself
//   empty-dir   a missing folder of that kind: an empty read-only stand-in, so the
//   empty-file  session can't create it either
// gitDirs lists every git folder, for the watcher.
export async function planMounts(folders) {
  const mounts = new Map();
  const add = (path, mode) => {
    if (!mounts.has(path)) mounts.set(path, mode);
  };
  const protect = async (path, type) => {
    const actual = await kind(path);
    add(path, actual ? "ro" : type === "dir" ? "empty-dir" : "empty-file");
  };
  const gitDirs = [];

  // One git folder: pin it, protect its control files, then its worktree admin
  // folders and submodules. Their parent folders are read-only, so no new
  // worktree or submodule can be added from inside.
  const gitDir = async (dir, depth) => {
    if (depth > 6) return;
    gitDirs.push(dir);
    add(dir, "rw");
    await protect(join(dir, "hooks"), "dir");
    for (const name of GIT_FILES)
      if (await kind(join(dir, name))) add(join(dir, name), "ro");
    for (const group of ["worktrees", "modules"]) {
      const parent = join(dir, group);
      await protect(parent, "dir");
      let entries = [];
      try {
        entries = await readdir(parent, { withFileTypes: true });
      } catch {}
      for (const entry of entries)
        if (entry.isDirectory()) await gitDir(join(parent, entry.name), depth + 1);
    }
  };

  for (const folder of folders) {
    add(folder, "rw");
    for (const name of FOLDER_DIRS) await protect(join(folder, name), "dir");
    for (const name of FOLDER_FILES) await protect(join(folder, name), "file");
    const top = await git(folder, "rev-parse", "--show-toplevel");
    if (!top) continue;
    let common = resolve(folder, await git(folder, "rev-parse", "--git-common-dir"));
    common = await realpath(common).catch(() => common);
    // A clone's .git folder is the git folder itself, not a file to stand in for.
    if ((await kind(join(folder, ".git"))) === "dir") mounts.delete(join(folder, ".git"));
    await gitDir(common, 0);
    // A hooks folder set in the config (husky and friends) runs on every commit.
    const hooksPath = await git(folder, "config", "--get", "core.hooksPath");
    if (hooksPath) {
      const abs = isAbsolute(hooksPath) ? hooksPath : resolve(top, hooksPath);
      if ([...folders, common].some((f) => within(abs, f))) await protect(abs, "dir");
    }
  }
  // Anything between a mount and a protected path is pinned too.
  const roots = [...mounts].filter(([, m]) => m === "rw").map(([p]) => p);
  for (const [path, mode] of [...mounts]) {
    if (mode === "rw") continue;
    const root = roots.filter((r) => r !== path && within(path, r)).sort((a, b) => b.length - a.length)[0];
    if (!root) continue;
    for (let dir = dirname(path); dir !== root && within(dir, root); dir = dirname(dir))
      add(dir, "rw");
  }
  const depth = (p) => p.split(sep).length;
  return {
    mounts: [...mounts]
      .map(([path, mode]) => ({ path, mode }))
      .sort((a, b) => depth(a.path) - depth(b.path)),
    gitDirs,
  };
}

// Folders a --plugin-dir needs: the dir itself and whatever its symlinks point to.
export async function pluginMounts(dirs) {
  const found = new Set();
  const walk = async (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await realpath(path).catch(() => null);
        if (target) found.add(target);
      } else if (entry.isDirectory()) await walk(path, depth + 1);
    }
  };
  for (const dir of dirs) {
    found.add(dir);
    await walk(dir, 0);
  }
  return [...found];
}

// The `docker run` arguments for the Claude container.
export function claudeRunArgs({
  id,
  image,
  network,
  user,
  home,
  homeVolume,
  start,
  plan,
  readOnly,
  standIn,
  env,
  tty,
  claudeArgs,
}) {
  const args = [
    "run",
    "--rm",
    "-i",
    ...(tty ? ["-t"] : []),
    "--init",
    "--name",
    id,
    "--hostname",
    "clx-workspace",
    "--network",
    network,
    "--user",
    user,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    // Docker Desktop's default is no system-call filter at all; ask for Docker's own.
    "--security-opt",
    "seccomp=builtin",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,exec,nosuid,size=4g",
    "--pids-limit",
    "2048",
    "--memory",
    "8g",
    "--mount",
    `type=volume,src=${homeVolume},dst=${home}`,
  ];
  const bind = (path, ro) =>
    args.push(
      "--mount",
      `type=bind,src=${path},dst=${path}${ro ? ",readonly" : ""}`,
    );
  for (const { path, mode } of plan.mounts) {
    if (mode === "rw" || mode === "ro") bind(path, mode === "ro");
    else if (mode === "empty-dir")
      // Root-owned and read-only: the session's user can't add anything inside.
      args.push(
        "--mount",
        `type=tmpfs,dst=${path},tmpfs-mode=0555,tmpfs-size=1k`,
      );
    else
      args.push("--mount", `type=bind,src=${standIn},dst=${path},readonly`);
  }
  for (const path of readOnly) bind(path, true);
  for (const [key, value] of Object.entries(env))
    args.push("-e", value === undefined ? key : `${key}=${value}`);
  args.push("-w", start, image, "claude", ...claudeArgs);
  return args;
}

// Host paths Docker created as mount points for the stand-ins: remove them afterwards
// if they're still empty, so the folders look as they did before.
export async function removeStandIns(plan) {
  for (const { path, mode } of [...plan.mounts].reverse()) {
    if (mode !== "empty-dir" && mode !== "empty-file") continue;
    try {
      const s = await lstat(path);
      if (s.isDirectory()) await rmdir(path);
      else if (s.isFile() && s.size === 0) await rm(path);
    } catch {}
  }
}

// Watches every git folder from the Mac while the session runs. A commondir that
// appears where there was none would point git at another config and hooks, so it's
// removed at once and onFound stops the session.
export async function gitWatch(gitDirs, onFound) {
  const missing = [];
  for (const dir of gitDirs)
    if (!(await kind(join(dir, "commondir")))) missing.push(dir);
  const check = async () => {
    const found = [];
    for (const dir of missing)
      if (await kind(join(dir, "commondir"))) {
        found.push(join(dir, "commondir"));
        await rm(join(dir, "commondir"), { recursive: true, force: true });
      }
    return found;
  };
  const watchers = missing.map((dir) =>
    watch(dir, async (_, name) => {
      if (name !== "commondir") return;
      const found = await check();
      if (found.length) onFound(found);
    }),
  );
  return {
    check,
    close: () => watchers.forEach((w) => w.close()),
  };
}
