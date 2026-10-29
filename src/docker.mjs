import { execFile } from "node:child_process";
import { watch } from "node:fs";
import {
  lstat,
  readdir,
  readFile,
  realpath,
  rm,
  rmdir,
} from "node:fs/promises";
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
// and object store to use. `config` and `config.worktree` get an empty read-only
// stand-in when missing (an empty config is valid). `commondir` and `gitdir` exist
// only in worktree admin folders; a missing one can't get a stand-in (git refuses an
// empty commondir), so docker-run watches for it instead (see gitWatch).
const GIT_CONFIGS = ["config", "config.worktree"];
const GIT_POINTERS = ["commondir", "gitdir"];

// Folders that aren't walked for nested repos and editor settings: dependency and
// build-output trees, which are large and don't normally hold a repo or settings the
// Mac acts on. A repo or auto-run file buried inside one is neither protected nor
// warned about, the same trade-off node_modules already made. `vendor` is NOT here:
// submodules and vendored repos live there.
export const SKIP_DIRS = new Set([
  "node_modules",
  ".venv",
  "venv",
  "target",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".gradle",
  "Pods",
  "DerivedData",
  "obj",
]);

// Names the Mac may act on by itself, for the after-session scan to warn about.
export const AUTORUN_NAMES = [...FOLDER_DIRS, ...FOLDER_FILES];

// Where a `.git` file points: "gitdir: <path>", relative to the file's folder.
async function gitFileTarget(file) {
  try {
    const text = await readFile(file, "utf8");
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
    if (!m) return null;
    const target = resolve(dirname(file), m[1]);
    return await realpath(target).catch(() => target);
  } catch {
    return null;
  }
}

// Plans every mount for the workspace folders, parents before children.
//   rw          a workspace folder, a git folder (inside or outside them), or a folder
//               bound onto itself so it can't be renamed away and replaced (rename
//               fails on a mount point)
//   ro          an existing file or folder the Mac acts on by itself
//   empty-dir   a missing folder of that kind: an empty read-only stand-in, so the
//   empty-file  session can't create it either
// Every folder is walked (except node_modules), so a repo, worktree or editor folder
// nested anywhere inside gets the same protection as one at the top. A missing one
// below the top isn't stood in for; docker-run warns about new ones afterwards.
// gitDirs lists every git folder, for the watcher. Throws when a hooks folder can't
// be protected because it is a workspace folder itself.
export async function planMounts(folders) {
  const mounts = new Map();
  const add = (path, mode) => {
    if (!mounts.has(path)) mounts.set(path, mode);
  };
  const protect = async (path, type) => {
    const actual = await kind(path);
    add(path, actual ? "ro" : type === "dir" ? "empty-dir" : "empty-file");
  };
  const gitDirs = new Set();

  // Under worktrees/ and modules/, a folder with a HEAD file is a git folder; anything
  // else is a namespace (the submodule "libs/child" lives at modules/libs/child) and
  // stays inside the read-only parent.
  const nested = async (parent, depth, level = 0) => {
    if (level > 6) return;
    let entries = [];
    try {
      entries = await readdir(parent, { withFileTypes: true });
    } catch {}
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(parent, entry.name);
      if ((await kind(join(path, "HEAD"))) === "file")
        await gitDir(path, depth);
      else await nested(path, depth, level + 1);
    }
  };

  // One git folder: pin it, protect its control files, then its worktree admin
  // folders and submodules, and the common git folder it points at. The worktrees/
  // and modules/ parents are read-only, so no new worktree or submodule can be added
  // from inside.
  const gitDir = async (dir, depth) => {
    if (depth > 6 || gitDirs.has(dir)) return;
    gitDirs.add(dir);
    add(dir, "rw");
    await protect(join(dir, "hooks"), "dir");
    for (const name of GIT_CONFIGS) await protect(join(dir, name), "file");
    for (const name of GIT_POINTERS)
      if (await kind(join(dir, name))) add(join(dir, name), "ro");
    for (const group of ["worktrees", "modules"]) {
      const parent = join(dir, group);
      await protect(parent, "dir");
      await nested(parent, depth + 1);
    }
    try {
      const common = resolve(
        dir,
        (await readFile(join(dir, "commondir"), "utf8")).trim(),
      );
      await gitDir(await realpath(common).catch(() => common), depth + 1);
    } catch {}
  };

  // A working tree: its `.git` folder or file, and the hooks folder its config names
  // (husky and friends), which runs on every commit. The hooks path is resolved
  // against the final mount set in a second pass (see hooksTargets), so a path in a
  // folder processed later is still caught.
  const hooksTargets = [];
  const workTree = async (top, depth) => {
    const dotGit = join(top, ".git");
    const what = await kind(dotGit);
    if (what === "dir")
      await gitDir(await realpath(dotGit).catch(() => dotGit), depth);
    else if (what === "file") {
      add(dotGit, "ro");
      // The `.git` entry may be a git-link file (gitdir: …) or a symlink to the real
      // git dir; either way, find and protect that dir.
      const target =
        (await gitFileTarget(dotGit)) ??
        (await realpath(dotGit).catch(() => null));
      if (target && (await kind(target)) === "dir") await gitDir(target, depth);
    } else return;
    const hooksPath = await git(top, "config", "--get", "core.hooksPath");
    if (hooksPath)
      hooksTargets.push(
        isAbsolute(hooksPath) ? hooksPath : resolve(top, hooksPath),
      );
  };

  // Everything inside a workspace folder that the Mac acts on by itself.
  const walk = async (dir, depth) => {
    if (depth > 12) return;
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {}
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const path = join(dir, entry.name);
      const settings =
        FOLDER_DIRS.includes(entry.name) || FOLDER_FILES.includes(entry.name);
      if (entry.isSymbolicLink()) {
        // Never descend through a symlink. A settings folder/file that is a symlink
        // still points at something the Mac acts on, so protect its target.
        if (settings) {
          const target = await realpath(path).catch(() => null);
          if (target)
            await protect(
              target,
              (await kind(target)) === "dir" ? "dir" : "file",
            );
        }
        continue;
      }
      if (settings) {
        add(path, "ro");
        continue;
      }
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      await workTree(path, 0);
      await walk(path, depth + 1);
    }
  };

  for (const folder of folders) {
    add(folder, "rw");
    for (const name of FOLDER_DIRS) await protect(join(folder, name), "dir");
    for (const name of FOLDER_FILES) await protect(join(folder, name), "file");
    // A clone's .git folder is the git folder itself, not a file to stand in for.
    if ((await kind(join(folder, ".git"))) === "dir")
      mounts.delete(join(folder, ".git"));
    await workTree(folder, 0);
    await walk(folder, 0);
  }
  // Second pass for core.hooksPath, now that every folder and git dir is mounted: a
  // hooks folder that is itself a writable workspace folder can't be protected, so
  // refuse; one that merely sits inside a writable mount is made read-only.
  for (const abs of hooksTargets) {
    if (mounts.get(abs) === "rw")
      throw new Error(
        `core.hooksPath resolves to ${abs}, a folder the session writes to, so its hooks can't be protected. Point core.hooksPath at a folder of its own, or leave that repo out of the docker workspace.`,
      );
    if ([...mounts].some(([p, m]) => m === "rw" && within(abs, p)))
      await protect(abs, "dir");
  }
  // Anything between a mount and a protected path is pinned too.
  const roots = [...mounts].filter(([, m]) => m === "rw").map(([p]) => p);
  for (const [path, mode] of [...mounts]) {
    if (mode === "rw") continue;
    const root = roots
      .filter((r) => r !== path && within(path, r))
      .sort((a, b) => b.length - a.length)[0];
    if (!root) continue;
    for (
      let dir = dirname(path);
      dir !== root && within(dir, root);
      dir = dirname(dir)
    )
      add(dir, "rw");
  }
  const depth = (p) => p.split(sep).length;
  return {
    mounts: [...mounts]
      .map(([path, mode]) => ({ path, mode }))
      .sort((a, b) => depth(a.path) - depth(b.path)),
    gitDirs: [...gitDirs],
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
    else args.push("--mount", `type=bind,src=${standIn},dst=${path},readonly`);
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

// In-progress rebase/cherry-pick/revert state. A session can write a git-rebase-todo
// with an `exec <command>` line; if that state is left in the repo, a later host
// `git rebase --continue` (which `git status` tells you to run) runs the command on
// the Mac. The session is over, so any such state is abandoned: remove what appeared
// during it, wherever a git dir holds it.
const REBASE_STATE = ["rebase-merge", "rebase-apply", "sequencer"];

// The rebase/sequencer state present in these git dirs right now, as a Set of paths.
export async function rebaseState(gitDirs) {
  const found = new Set();
  for (const dir of gitDirs)
    for (const name of REBASE_STATE)
      if (await kind(join(dir, name))) found.add(join(dir, name));
  return found;
}

// Remove any rebase/sequencer state in gitDirs that is not in `before`. Returns one
// `{ path, branch }` per removal, where `branch` is the branch the rebase was started
// from (read before deleting), so docker-run can tell you how to get back — removing
// the state can leave the repo on a detached HEAD.
export async function sweepRebaseState(gitDirs, before) {
  const removed = [];
  for (const path of await rebaseState(gitDirs))
    if (!before.has(path)) {
      let branch = null;
      try {
        branch = (await readFile(join(path, "head-name"), "utf8"))
          .trim()
          .replace(/^refs\/heads\//, "");
      } catch {}
      await rm(path, { recursive: true, force: true }).catch(() => {});
      removed.push({ path, branch });
    }
  return removed;
}
