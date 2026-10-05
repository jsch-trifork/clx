import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

// A workspace scopes a Claude session to a few folders. Everything else in the home
// folder (and in any extra fence roots) is denied to Claude's file tools, subagents
// included, and to shell commands via Claude Code's built-in sandbox. Tools that act
// outside the sandbox with your identity (browser, cloud agents, other sessions,
// WebFetch) are removed, and the shell has no network beyond the workspace's list.

const GITHUB_DOMAINS = [
  "github.com",
  "api.github.com",
  "*.githubusercontent.com",
];
const GITHUB_DENIED = ["github.com", "*.github.com", "*.githubusercontent.com"];

// Tools that reach outside the sandbox: the signed-in browser, cloud routines, and
// other Claude sessions on this machine (which could read files on our behalf).
const OUTSIDE_TOOLS = [
  "mcp__claude-in-chrome",
  "RemoteTrigger",
  "SendMessage",
  "ListAgents",
];

// Home-relative paths shell commands may still read: toolchains and shell config,
// nothing that holds projects, history or credentials. Extend per workspace with
// "allowRead".
const SHELL_READABLE = [
  // JavaScript
  ".bun",
  ".bunfig.toml",
  ".npm",
  ".nvm",
  ".volta",
  ".yarn",
  ".yarnrc",
  ".deno",
  "Library/pnpm",
  // .NET
  ".dotnet",
  ".nuget",
  ".templateengine",
  ".aspnet",
  ".microsoft",
  ".net",
  // JVM
  ".gradle",
  ".m2",
  ".sdkman",
  ".konan",
  ".jdks",
  ".sbt",
  ".ivy2",
  // Python
  ".pyenv",
  ".rye",
  ".conda",
  "miniconda3",
  "anaconda3",
  "miniforge3",
  // Go, Rust, Ruby, Dart/Flutter, Swift, PHP
  "go",
  ".cargo",
  ".rustup",
  ".gem",
  ".rbenv",
  ".bundle",
  ".pub-cache",
  "fvm",
  ".swiftpm",
  ".composer",
  // Version managers and shared caches
  ".asdf",
  ".local",
  ".cache",
  "Library/Caches/go-build",
  "Library/Caches/pip",
  // Android SDK (not ~/.android, which holds adb keys)
  "Library/Android",
  // Shell and git config
  ".gitconfig",
  ".gitignore_global",
  ".config/git",
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".bashrc",
  ".bash_profile",
  ".profile",
  ".CFUserTextEncoding",
  // macOS developer tools
  "Library/Developer",
  "Library/Preferences",
  // Claude Code's own runtime files and your skills
  ".claude/plugins",
  ".claude/skills",
  ".claude/shell-snapshots",
  ".claude/session-env",
];

// Files inside a workspace folder that would let Claude change its own limits or
// run code outside the sandbox (hooks, settings, MCP servers, git hooks).
const CONFIG_PATHS = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude/hooks",
  ".claude/skills",
  ".claude/agents",
  ".claude/commands",
  ".mcp.json",
  ".git/hooks",
  ".git/config",
];

// Writable system folders whose programs later run outside the sandbox.
const SYSTEM_WRITABLE = ["/opt/homebrew", "/usr/local"];

// Toolchain folders shell commands may write: .NET's lock folder and package caches.
const SHELL_WRITABLE = [
  "/private/tmp/.dotnet",
  "~/.nuget/packages",
  "~/.npm",
  "~/go/pkg/mod",
  "~/Library/Caches/go-build",
  "~/Library/Caches/pip",
];

export const expandHome = (path, home = homedir()) =>
  path === "~"
    ? home
    : path.startsWith("~/")
      ? join(home, path.slice(2))
      : path;

const absolute = (path, home) => resolve(expandHome(path, home));

// Claude Code keeps per-folder history and memory under ~/.claude/projects/<slug>,
// and session scratch space under /private/tmp/claude-<uid>/<slug>.
export const projectSlug = (path) => path.replace(/[^a-zA-Z0-9]/g, "-");

const within = (path, root) => path === root || path.startsWith(root + sep);

// ---- Editing the workspaces file (clx workspaces) ----

const LIST_KEYS = ["dirs", "mcp", "network", "allowRead", "fence"];
const FLAG_KEYS = ["github", "web"];
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Store paths as ~/… so the file stays readable and portable between machines.
const tildify = (path, home) =>
  within(path, home) ? "~" + path.slice(home.length) : path;

// Checks a workspace entry and returns it normalised. Unknown keys are refused,
// so a typo can't silently leave a workspace weaker than intended.
export async function checkEntry(entry, home = homedir()) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry))
    throw new Error("A workspace must be a JSON object.");
  for (const key of Object.keys(entry))
    if (key !== "start" && !LIST_KEYS.includes(key) && !FLAG_KEYS.includes(key))
      throw new Error(`Unknown workspace setting '${key}'.`);
  if (typeof entry.start !== "string" || !entry.start)
    throw new Error('A workspace needs a "start" folder.');
  const out = { start: tildify(absolute(entry.start, home), home) };
  if (!(await isDir(absolute(entry.start, home))))
    throw new Error(`Folder not found: ${entry.start}`);
  for (const key of LIST_KEYS) {
    if (entry[key] === undefined) continue;
    if (
      !Array.isArray(entry[key]) ||
      entry[key].some((v) => typeof v !== "string")
    )
      throw new Error(`"${key}" must be a list of strings.`);
    out[key] = entry[key];
  }
  if (out.dirs) {
    out.dirs = [];
    for (const dir of entry.dirs) {
      if (!(await isDir(absolute(dir, home))))
        throw new Error(`Folder not found: ${dir}`);
      out.dirs.push(tildify(absolute(dir, home), home));
    }
  }
  for (const key of FLAG_KEYS) {
    if (entry[key] === undefined) continue;
    if (typeof entry[key] !== "boolean")
      throw new Error(`"${key}" must be true or false.`);
    out[key] = entry[key];
  }
  return out;
}

async function readRaw(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`${file} is not valid JSON.`);
  }
}

// Write via a temp file and rename, so an interrupted save never truncates the file.
async function writeRaw(file, data) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
  await rename(tmp, file);
}

export async function saveWorkspace(file, name, entry, home = homedir()) {
  if (!NAME.test(name))
    throw new Error(
      "Use letters, digits, '.', '_' or '-' for the name, without spaces.",
    );
  const data = await readRaw(file);
  data.workspaces = {
    ...data.workspaces,
    [name]: await checkEntry(entry, home),
  };
  await writeRaw(file, data);
}

export async function renameWorkspace(file, from, to) {
  if (!NAME.test(to))
    throw new Error(
      "Use letters, digits, '.', '_' or '-' for the name, without spaces.",
    );
  const data = await readRaw(file);
  if (!data.workspaces?.[from])
    throw new Error(`No workspace named '${from}'.`);
  if (data.workspaces[to]) throw new Error(`'${to}' already exists.`);
  // Rebuild to keep the renamed workspace in its place in the list.
  data.workspaces = Object.fromEntries(
    Object.entries(data.workspaces).map(([k, v]) => [k === from ? to : k, v]),
  );
  await writeRaw(file, data);
}

export async function deleteWorkspace(file, name) {
  const data = await readRaw(file);
  if (!data.workspaces?.[name])
    throw new Error(`No workspace named '${name}'.`);
  delete data.workspaces[name];
  await writeRaw(file, data);
}

export async function readWorkspaces(file) {
  let data;
  try {
    data = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { fence: [], workspaces: {} };
    throw new Error(`${file} is not valid JSON.`);
  }
  return { fence: data.fence ?? [], workspaces: data.workspaces ?? {} };
}

export function resolveWorkspace(config, name, home = homedir()) {
  const entry = config.workspaces[name];
  if (!entry) throw new Error(`No workspace named '${name}'.`);
  if (!entry.start)
    throw new Error(`Workspace '${name}' needs a "start" folder.`);
  return {
    name,
    start: absolute(entry.start, home),
    dirs: (entry.dirs ?? []).map((p) => absolute(p, home)),
    // Extra roots beyond the home folder, e.g. an external drive with code.
    fence: (entry.fence ?? config.fence).map((p) => absolute(p, home)),
    allowRead: (entry.allowRead ?? []).map((p) => absolute(p, home)),
    network: entry.network ?? [],
    mcp: entry.mcp ?? [],
    github: entry.github === true,
    web: entry.web === true,
    // Only `clx --chrome` turns the browser on, one launch at a time.
    chrome: false,
  };
}

// Every entry under `root` that is neither an open folder nor on the way to one.
// Deny rules beat allow rules, so the fence is built from the siblings instead.
async function outside(root, open) {
  if (open.some((a) => within(root, a))) return [];
  if (!open.some((a) => within(a, root))) return [root];
  let names;
  try {
    names = await readdir(root);
  } catch {
    return [root];
  }
  const found = [];
  for (const name of names)
    found.push(...(await outside(join(root, name), open)));
  return found;
}

async function isDir(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// Permission rules take `//abs/path` for an absolute filesystem path.
const rule = async (tool, path) =>
  `${tool}(/${path}${(await isDir(path)) ? "/**" : ""})`;

// For paths that may not exist yet: cover the path itself and anything below it.
const rules = (tool, path) => [`${tool}(/${path})`, `${tool}(/${path}/**)`];

export async function workspaceSettings(ws, options = {}) {
  const home = options.home ?? homedir();
  const claudeDir = options.claudeDir ?? join(home, ".claude");
  const tmpRoot = options.tmpRoot ?? `/private/tmp/claude-${process.getuid()}`;
  const protect = options.protect ?? [];

  const own = [ws.start, ...ws.dirs];
  for (const dir of own)
    if (!(await isDir(dir)))
      throw new Error(`Workspace folder not found: ${dir}`);

  // This workspace's own history/memory and session scratch space stay open.
  const history = own.map((d) => join(claudeDir, "projects", projectSlug(d)));
  const scratch = own.map((d) => join(tmpRoot, projectSlug(d)));
  const editOpen = [...own, ...history, ...scratch];
  const readOpen = [
    ...editOpen,
    join(claudeDir, "plugins"),
    join(claudeDir, "skills"),
  ];

  const roots = [home, tmpRoot, ...ws.fence];
  const readHidden = [];
  const editHidden = [];
  for (const root of roots)
    if (await exists(root)) {
      readHidden.push(...(await outside(root, readOpen)));
      editHidden.push(...(await outside(root, editOpen)));
    }
  for (const dir of SYSTEM_WRITABLE)
    if (await exists(dir)) editHidden.push(dir);
  editHidden.push(...protect);

  const deny = [
    ...OUTSIDE_TOOLS.filter(
      (t) => !(ws.chrome && t === "mcp__claude-in-chrome"),
    ),
    ...(ws.web ? [] : ["WebFetch"]),
  ];
  for (const path of readHidden) deny.push(await rule("Read", path));
  for (const path of editHidden) deny.push(await rule("Edit", path));
  for (const dir of own)
    for (const path of CONFIG_PATHS)
      deny.push(...rules("Edit", join(dir, path)));

  const domains = [...ws.network, ...(ws.github ? GITHUB_DOMAINS : [])];
  return {
    permissions: { additionalDirectories: ws.dirs, deny },
    // Plans default to ~/.claude/plans, shared by every project; keep them local.
    plansDirectory: ".claude/plans",
    // .NET gives up when it can't list the home folder; tell it where home is.
    env: {
      DOTNET_CLI_HOME: home,
      NUGET_PACKAGES: join(home, ".nuget/packages"),
    },
    hooks: {
      PreToolUse: [
        {
          matcher: "Agent",
          hooks: [{ type: "command", command: `node "${options.guard}"` }],
        },
      ],
    },
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      // Go tools such as gh need trustd to verify TLS; only relevant when GitHub is open.
      ...(ws.github && { enableWeakerNetworkIsolation: true }),
      filesystem: {
        denyRead: roots,
        allowRead: [
          ...editOpen,
          ...SHELL_READABLE.map((p) => join(home, p)),
          ...ws.allowRead,
        ],
        allowWrite: [
          ...ws.dirs,
          ...SHELL_WRITABLE.map((p) => expandHome(p, home)),
        ],
      },
      // strictAllowlist stops auto mode widening access per command (allowed_domains);
      // deniedDomains keeps GitHub shut even if some other settings source allows it.
      network: {
        allowedDomains: domains,
        strictAllowlist: true,
        ...(!ws.github && { deniedDomains: GITHUB_DENIED }),
      },
    },
  };
}

// Deep merge where arrays concatenate, so the user's own deny rules survive.
export function mergeSettings(base, extra) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const current = out[key];
    if (Array.isArray(value))
      out[key] = [
        ...new Set([...(Array.isArray(current) ? current : []), ...value]),
      ];
    else if (value && typeof value === "object")
      out[key] = mergeSettings(
        current && typeof current === "object" ? current : {},
        value,
      );
    else out[key] = value;
  }
  return out;
}
