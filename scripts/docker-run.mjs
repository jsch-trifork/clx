// Runs Claude Code for a docker workspace (clx -w NAME --docker), called from clx.zsh:
//   docker-run.mjs <workspaces.json> <name> [read-only paths...] -- <claude args...>
// Read-only paths are clx's generated files (settings, MCP config, prompt, plugins).
import { spawn, execFile } from "node:child_process";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  readdir,
} from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { readWorkspaces, resolveWorkspace } from "../src/workspaces.mjs";
import {
  CLAUDE_DOMAINS,
  claudeRunArgs,
  planMounts,
  pluginMounts,
  removeStandIns,
  gitWatch,
  rebaseState,
  sweepRebaseState,
  AUTORUN_NAMES,
  SKIP_DIRS,
} from "../src/docker.mjs";

const exec = promisify(execFile);
const say = (msg) => console.error(`clx: ${msg}`);
const GITHUB = ["github.com", "api.github.com", "*.githubusercontent.com"];
const TOKEN_SERVICE = "clx-docker-token";
const scripts = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

// Docker Desktop can reach every folder it shares, so a container escape would reach
// them too. Warn when that includes the whole home folder.
async function fileSharingWarning(home) {
  const file = join(
    home,
    "Library/Group Containers/group.com.docker/settings-store.json",
  );
  try {
    const { FilesharingDirectories: dirs = [] } = JSON.parse(
      await readFile(file, "utf8"),
    );
    const wide = dirs.filter((d) => home === d || home.startsWith(d + "/"));
    if (wide.length)
      say(
        `note: Docker Desktop shares ${wide.join(", ")}, so it can reach your whole home folder. Narrow it to your code folders plus /var/folders under Settings → Resources → File sharing.`,
      );
  } catch {}
}

const docker = async (...args) => (await exec("docker", args)).stdout.trim();
const quiet = (...args) => docker(...args).catch(() => "");

async function ensureImage(ws, version) {
  if (ws.image) return ws.image;
  const tag = `clx-workspace:${version}`;
  if (await quiet("image", "inspect", "--format", "{{.Id}}", tag)) return tag;
  say(`building ${tag} (once per Claude Code version)…`);
  await new Promise((done, fail) =>
    spawn(
      "docker",
      [
        "build",
        "-q",
        "--build-arg",
        `CLAUDE_VERSION=${version}`,
        "-t",
        tag,
        join(scripts, "..", "docker"),
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    ).on("exit", (code) =>
      code === 0 ? done() : fail(new Error("docker build failed")),
    ),
  );
  return tag;
}

// A long-lived token from `claude setup-token`, kept in your login Keychain. It's
// inside the container (the session needs it), but the network only lets it reach
// Anthropic.
async function token() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN)
    return { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  if (process.env.ANTHROPIC_API_KEY)
    return { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  const user = userInfo().username;
  try {
    const { stdout } = await exec("security", [
      "find-generic-password",
      "-s",
      TOKEN_SERVICE,
      "-a",
      user,
      "-w",
    ]);
    if (stdout.trim()) return { CLAUDE_CODE_OAUTH_TOKEN: stdout.trim() };
  } catch {}
  if (!process.stdin.isTTY)
    throw new Error(
      "docker workspaces need a token: run `claude setup-token`, then launch again in a terminal to paste it.",
    );
  say(
    "Docker sessions can't use your Mac's Claude login. Run `claude setup-token` in another terminal and paste the token here (it's stored in your Keychain):",
  );
  const value = await hiddenInput();
  if (!value) throw new Error("no token given");
  // Through `security -i` so the token never shows up in the process list.
  await new Promise((done, fail) => {
    const child = spawn("security", ["-i"], {
      stdio: ["pipe", "ignore", "inherit"],
    });
    child.on("exit", (code) =>
      code === 0 ? done() : fail(new Error("couldn't save the token")),
    );
    child.stdin.end(
      `add-generic-password -U -s ${TOKEN_SERVICE} -a ${user} -w ${value}\n`,
    );
  });
  return { CLAUDE_CODE_OAUTH_TOKEN: value };
}

function hiddenInput() {
  return new Promise((done) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    rl._writeToOutput = () => {};
    rl.question("", (answer) => {
      rl.close();
      process.stderr.write("\n");
      done(answer.trim());
    });
  });
}

// The home volume starts empty and root-owned: hand it to your user once.
async function prepareHome(volume, image, home, user) {
  if (await quiet("volume", "inspect", volume)) return;
  await docker("volume", "create", volume);
  await docker(
    "run",
    "--rm",
    "--user",
    "0",
    "--network",
    "none",
    "--security-opt",
    "seccomp=builtin",
    "--mount",
    `type=volume,src=${volume},dst=${home}`,
    image,
    "sh",
    "-c",
    `echo '{"hasCompletedOnboarding":true}' > "${home}/.claude.json" && chown -R ${user} "${home}"`,
  );
}

// Folders and files that make the Mac run code when they appear (a new repo's hooks,
// editor tasks, Claude settings), found before and after the session. The same names
// the mount plan protects, scanned to the same depth and skipping the same build-output
// folders, so the warning matches what is protected.
const WATCH = new Set(AUTORUN_NAMES);
async function watched(roots) {
  const found = new Set();
  const walk = async (dir, depth) => {
    if (depth > 12) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (WATCH.has(entry.name)) found.add(join(dir, entry.name));
      if (
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        !WATCH.has(entry.name) &&
        !SKIP_DIRS.has(entry.name)
      )
        await walk(join(dir, entry.name), depth + 1);
    }
  };
  for (const root of roots) await walk(root, 0);
  return found;
}

const sep = process.argv.indexOf("--");
const [file, name, ...readOnlyArgs] = process.argv.slice(
  2,
  sep < 0 ? undefined : sep,
);
const claudeArgs = sep < 0 ? [] : process.argv.slice(sep + 1);

const id = `clx-${name.replace(/[^a-zA-Z0-9_.-]/g, "-")}-${process.pid}`;
const network = `${id}-net`;
const egress = `${id}-egress`;
let plan;
let tmp;
let watcher;
let folders = [];
let before = new Set();
let rebaseBefore = new Set();
let stopped = [];
let finished = false;

// Everything that must happen once the session is over, however it ended. The Claude
// container is killed first, so nothing inside can race the checks that follow: the
// final commondir sweep, removing any rebase/cherry-pick state the session left
// behind (a later host `git rebase --continue` would run its `exec` lines), the
// proxy's blocked list (read before the proxy goes), then the containers, network and
// stand-ins, and last the warning about new auto-run files.
async function finish() {
  if (finished) return;
  finished = true;
  await quiet("rm", "-f", id);
  if (watcher) {
    stopped.push(...(await watcher.check()));
    watcher.close();
  }
  if (stopped.length)
    say(
      `STOPPED: the session tried to redirect git to another config (${stopped.join(", ")}). It was removed and the session ended.`,
    );
  if (plan) {
    const rebased = await sweepRebaseState(plan.gitDirs, rebaseBefore);
    for (const { path, branch } of rebased) {
      const back = branch
        ? ` Your repo may be on a detached HEAD; get back with: git checkout ${branch}`
        : " Your repo may be on a detached HEAD; 'git checkout <branch>' returns to your branch.";
      say(
        `removed an in-progress rebase/cherry-pick the session left (${path}); do NOT run 'git rebase --continue'.${back} The session's commits are still in the reflog.`,
      );
    }
  }
  const blocked = (
    await exec("docker", ["logs", egress]).catch((e) => e)
  ).stderr
    ?.split("\n")
    .filter((l) => l.startsWith("clx-egress: blocked"));
  if (blocked?.length) {
    const hosts = [...new Set(blocked.map((l) => l.split(" ")[2]))];
    say(
      `the network blocked: ${hosts.join(", ")} (add a domain under "network" if it's needed)`,
    );
  }
  await quiet("rm", "-f", egress);
  await quiet("network", "rm", network);
  if (plan) await removeStandIns(plan);
  if (tmp) await rm(tmp, { recursive: true, force: true });
  const after = await watched(folders);
  const appeared = [...after].filter((p) => !before.has(p));
  if (appeared.length)
    say(
      `WARNING: the session created files your Mac may run on its own. Check them before using git or an editor there:\n  ${appeared.join("\n  ")}`,
    );
}
for (const [signal, code] of [
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
])
  process.on(signal, () => finish().finally(() => process.exit(code)));

try {
  if (!(await quiet("info", "--format", "{{.ServerVersion}}")))
    throw new Error(
      "Docker isn't running. Start Docker Desktop and try again.",
    );
  const ws = resolveWorkspace(await readWorkspaces(file), name);
  const home = homedir();
  await fileSharingWarning(home);
  const { uid, gid } = userInfo();
  const user = `${uid}:${gid}`;
  const version = (await exec("claude", ["--version"])).stdout.split(" ")[0];
  const image = await ensureImage(ws, version);
  const auth = await token();

  folders = [ws.start, ...ws.dirs];
  plan = await planMounts(folders);
  before = await watched(folders);
  // Rebase/cherry-pick state that was already in progress before launch is the user's
  // own; only state that appears during the session is swept at the end.
  rebaseBefore = await rebaseState(plan.gitDirs);
  tmp = await mkdtemp(join(tmpdir(), "clx-docker-"));
  const standIn = join(tmp, "empty");
  await writeFile(standIn, "");

  // Plugins and skills come in read-only, with whatever their symlinks point to.
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const pluginDirs = claudeArgs.flatMap((a, i) =>
    claudeArgs[i - 1] === "--plugin-dir" ? [a] : [],
  );
  const readOnly = [
    ...new Set([
      ...readOnlyArgs,
      scripts,
      ...(await pluginMounts([
        join(claudeDir, "plugins"),
        join(claudeDir, "skills"),
        ...pluginDirs,
      ])),
    ]),
  ].filter((p) => !folders.some((f) => p === f || p.startsWith(f + "/")));
  const mounts = [];
  for (const p of readOnly)
    try {
      await access(p);
      mounts.push(p);
    } catch {}

  const allow = [
    ...CLAUDE_DOMAINS,
    ...ws.network,
    ...(ws.github ? GITHUB : []),
  ];
  const homeVolume = `clx-home-${name.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
  await prepareHome(homeVolume, image, home, user);

  // The internal network has no route out and no DNS. The proxy sits on it and on
  // Docker's normal network, and is the session's only way out.
  await docker("network", "create", "--internal", network);
  await docker(
    "run",
    "-d",
    "--rm",
    "--name",
    egress,
    "--user",
    "1000:1000",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--security-opt",
    "seccomp=builtin",
    "--read-only",
    "--memory",
    "256m",
    "--mount",
    `type=bind,src=${join(scripts, "egress-proxy.mjs")},dst=/egress.mjs,readonly`,
    "-e",
    `CLX_ALLOW=${allow.join(",")}`,
    image,
    "node",
    "/egress.mjs",
    "3128",
  );
  await docker("network", "connect", "--alias", "clx-egress", network, egress);

  const proxy = "http://clx-egress:3128";
  const gitName = (
    await exec("git", ["config", "--get", "user.name"]).catch(() => ({
      stdout: "",
    }))
  ).stdout.trim();
  const gitEmail = (
    await exec("git", ["config", "--get", "user.email"]).catch(() => ({
      stdout: "",
    }))
  ).stdout.trim();
  const env = {
    HOME: home,
    USER: userInfo().username,
    TERM: process.env.TERM ?? "xterm-256color",
    COLORTERM: process.env.COLORTERM,
    HTTPS_PROXY: proxy,
    https_proxy: proxy,
    HTTP_PROXY: proxy,
    http_proxy: proxy,
    ...(process.env.CLAUDE_CONFIG_DIR && { CLAUDE_CONFIG_DIR: claudeDir }),
    ...(gitName && { GIT_AUTHOR_NAME: gitName, GIT_COMMITTER_NAME: gitName }),
    ...(gitEmail && {
      GIT_AUTHOR_EMAIL: gitEmail,
      GIT_COMMITTER_EMAIL: gitEmail,
    }),
    // Passed by name only, so the token isn't in the docker command line.
    ...Object.fromEntries(Object.keys(auth).map((k) => [k, undefined])),
  };
  for (const key of Object.keys(env)) if (env[key] === "") delete env[key];
  const args = claudeRunArgs({
    id,
    image,
    network,
    user,
    home,
    homeVolume,
    start: ws.start,
    plan,
    readOnly: mounts,
    standIn,
    env,
    tty: process.stdin.isTTY,
    claudeArgs,
  });
  // Git folders outside the workspace folders (a linked worktree's main repo) are
  // mounted too, so git works; say so.
  const shared = plan.mounts
    .filter(
      ({ path, mode }) =>
        mode === "rw" &&
        !folders.some((f) => path === f || path.startsWith(f + "/")),
    )
    .map(({ path }) => path);
  say(
    `docker workspace '${name}': ${folders.length} folder(s) mounted${shared.length ? ` plus the git folder(s) ${shared.join(", ")}` : ""}; network: ${allow.join(", ")}`,
  );
  watcher = await gitWatch(plan.gitDirs, (found) => {
    stopped.push(...found);
    quiet("rm", "-f", id);
  });
  const code = await new Promise((done) =>
    spawn("docker", args, {
      stdio: "inherit",
      env: { ...process.env, ...auth },
    }).on("exit", (c) => done(c ?? 1)),
  );

  await finish();
  process.exitCode = code;
} catch (error) {
  say(error.message);
  await finish();
  process.exitCode = 1;
}
