#!/usr/bin/env node
import { spawn, execFile } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { StoreError } from "../src/store.mjs";
import { initializeCatalog, setupLocation } from "../src/setup.mjs";
import { Profiles } from "../src/profiles.mjs";
import { startServer } from "../src/server.mjs";

import { version, update, versionCheck } from "../src/update.mjs";

const appDir = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
let profileChoice;
const profileFlag = args.indexOf("--profile");
if (profileFlag >= 0) {
  profileChoice = args[profileFlag + 1];
  if (!profileChoice || profileChoice.startsWith("--")) {
    console.error("clx: --profile needs a profile name");
    process.exit(1);
  }
  args.splice(profileFlag, 2);
}
async function chooseProfile(manager) {
  const state = await manager.list();
  if (profileChoice) return manager.select(profileChoice);
  if (state.profiles.length < 2) {
    manager.activeId = state.profiles[0].id;
    return;
  }
  if (!process.stdin.isTTY)
    throw new Error(
      "Multiple Claude profiles are configured. Use --profile NAME, or choose in clx ui.",
    );
  const name = await new Promise((resolve, reject) => {
    const child = spawn(
      "gum",
      [
        "choose",
        "--header",
        "Claude profile:",
        "--",
        ...state.profiles.map((p) => p.name),
      ],
      { stdio: ["inherit", "pipe", "inherit"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(output.trim())
        : reject(new Error("Profile selection cancelled.")),
    );
  });
  await manager.select(name);
}
const help = `CLX — Claude Code launcher and skill constellation\n\n  clx ui [--no-open] [--port 0] [--config-dir PATH]\n  clx update                         Install the latest stable release\n  clx --version                      Show the installed version\n  clx init [--force] [--config-dir PATH] [--claude-config-dir PATH]\n  clx [--profile NAME] [preset name]    Launch Claude in this terminal\n\nUI saves use the same presets.json as the terminal launcher.\nRequires Node 20+. Terminal launch/discovery also needs zsh, jq, gum and Claude Code.\nConfig: CLX_DIR, CLX_CATALOG, CLX_PRESETS; default ~/.claude/clx.\n`;
function run(command, argv, env = process.env) {
  const child = spawn(command, argv, { stdio: "inherit", env });
  child.on("error", (e) => {
    console.error(`clx: ${e.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
  });
}
try {
  if (args.includes("--help") || args[0] === "-h") console.log(help);
  else if (args[0] === "--version" || args[0] === "-v")
    console.log(`clx ${version}`);
  else if (args[0] === "update") {
    if (args.length !== 1) throw new Error("Usage: clx update");
    await update();
  } else if (["ui", "init"].includes(args[0])) {
    const command = args.shift();
    const { values } = parseArgs({
      args,
      options: {
        "no-open": { type: "boolean" },
        port: { type: "string", default: "0" },
        "config-dir": { type: "string" },
        "claude-config-dir": { type: "string" },
        force: { type: "boolean" },
      },
    });
    const dir = resolve(
      values["config-dir"] ||
        process.env.CLX_DIR ||
        join(homedir(), ".claude/clx"),
    );
    const catalogFile = process.env.CLX_CATALOG || join(dir, "loadout.json");
    const presetsFile = process.env.CLX_PRESETS || join(dir, "presets.json");
    const profiles = new Profiles(dir, catalogFile);
    profiles.activeId = (await profiles.list()).profiles[0].id;
    if (profileChoice) {
      if (command === "init") {
        const selected = (await profiles.list()).profiles.find(
          (p) => p.id === profileChoice || p.name === profileChoice,
        );
        if (!selected) throw new Error("Choose an existing Claude profile.");
        profiles.activeId = selected.id;
      } else await profiles.select(profileChoice);
    }
    if (command === "init") {
      await initializeCatalog(
        profiles.catalog(),
        values["claude-config-dir"] ||
          (profileChoice ? (await profiles.current()).directory : undefined),
        values.force,
      );
      const state = await profiles.list();
      if (state.persisted) {
        const current = await profiles.current();
        await profiles.mutate({
          operation: "update",
          ...current,
          directory: (await setupLocation(profiles.catalog())).directory,
          revision: state.revision,
        });
      }
      console.log(`CLX catalog ready: ${profiles.catalog()}`);
    } else {
      const port = Number(values.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new Error("Port must be 0–65535.");
      if (values["claude-config-dir"])
        throw new Error(
          "Use clx init --claude-config-dir PATH --force to choose the Claude configuration folder.",
        );
      let running = false,
        scanning = false;
      const { server, url } = await startServer({
        catalogFile,
        onVersion: versionCheck(),
        getCatalogFile: () => profiles.catalog(),
        onProfiles: async (request) => {
          if (!request)
            return {
              ...(await profiles.list()),
              chosen: Boolean(profileChoice),
            };
          if (running || scanning)
            throw new StoreError(
              "Finish the current session or scan before changing profiles.",
              409,
            );
          scanning = true;
          try {
            return request.operation === "select"
              ? await profiles.select(request.id)
              : await profiles.mutate(request);
          } finally {
            scanning = false;
          }
        },
        presetsFile,
        port,
        onSetup: async (request) => {
          if (running)
            throw new StoreError(
              "Finish the running Claude session before changing folders.",
              409,
            );
          if (request) {
            if (scanning)
              throw new StoreError(
                "A folder scan is already running. Wait for it to finish.",
                409,
              );
            scanning = true;
            try {
              const state = await profiles.list();
              const current = await profiles.current();
              await profiles.mutate({
                operation: "update",
                ...current,
                directory: request.directory,
                revision: state.revision,
              });
            } finally {
              scanning = false;
            }
          }
          return { directory: (await profiles.current()).directory };
        },
        onLaunch: async (name, launchRequest = {}) => {
          await profiles.verifyCatalog();
          const active = await profiles.current();
          if (launchRequest.profileId !== active.id)
            throw new StoreError(
              "The profile changed. Reload before launching.",
              409,
            );
          if (scanning)
            throw new StoreError(
              "Wait for the folder scan to finish before launching.",
              409,
            );
          if (running)
            throw new StoreError(
              "A Claude session is already running in this terminal.",
              409,
            );
          running = true;
          try {
            await promisify(execFile)("zsh", [
              "-c",
              'for dependency in gum jq "$1"; do command -v "$dependency" >/dev/null || { print -ru2 -- "Missing dependency: $dependency"; exit 1; }; done',
              "clx",
              active.executable,
            ]);
          } catch (error) {
            running = false;
            throw new StoreError(
              error.stderr?.trim() ||
                "Install zsh, jq, gum and Claude Code before launching.",
              422,
            );
          }
          const child = spawn(
            "zsh",
            [
              "-c",
              'source "$1"; shift; clx "$@"',
              "clx",
              join(appDir, "clx.zsh"),
              name,
            ],
            {
              stdio: "inherit",
              env: {
                ...process.env,
                CLX_DIR: dir,
                CLX_CATALOG: profiles.catalog(),
                CLX_CLAUDE_BIN: active.executable,
                CLX_PROFILE_READY: "1",
                CLX_ALLOW_MISSING:
                  launchRequest.allowMissing === true ? "1" : "",
                CLX_PRESETS: presetsFile,
                CLX_BOOTSTRAP:
                  process.env.CLX_BOOTSTRAP || join(appDir, "bootstrap.zsh"),
              },
            },
          );
          running = true;
          child.on("exit", (code) => {
            running = false;
            console.log(
              `\nCLX session ended (${code ?? "interrupted"}). Constellation is still open.\n`,
            );
          });
          await new Promise((resolve, reject) => {
            child.once("spawn", resolve);
            child.once("error", (error) => {
              running = false;
              reject(error);
            });
          });
        },
      });
      console.log(
        `\nCLX ${version} constellation\n${url}\n\nPresets: ${presetsFile}\nKeep this terminal open. Press Ctrl+C to stop.\n`,
      );
      if (!values["no-open"]) {
        const command =
          process.platform === "darwin"
            ? "open"
            : process.platform === "win32"
              ? null
              : "xdg-open";
        if (command) {
          const opener = spawn(command, [url], { stdio: "ignore" });
          opener.on("error", () =>
            console.log("Open the URL above in your browser."),
          );
        }
      }
      for (const signal of ["SIGINT", "SIGTERM"])
        process.on(signal, () => {
          server.close();
          server.closeAllConnections();
        });
    }
  } else {
    const dir = resolve(process.env.CLX_DIR || join(homedir(), ".claude/clx"));
    const profiles = new Profiles(
      dir,
      process.env.CLX_CATALOG || join(dir, "loadout.json"),
    );
    if (args[0] !== "prompts") await chooseProfile(profiles);
    if (args[0] !== "prompts") await profiles.verifyCatalog();
    const active = await profiles.current();
    run(
      "zsh",
      [
        "-c",
        'source "$1"; shift; clx "$@"',
        "clx",
        join(appDir, "clx.zsh"),
        ...args,
      ],
      {
        ...process.env,
        CLX_PROFILE_READY: "1",
        CLX_CLAUDE_BIN: active.executable,
        CLX_CATALOG: profiles.catalog(),
        CLX_BOOTSTRAP:
          process.env.CLX_BOOTSTRAP || join(appDir, "bootstrap.zsh"),
      },
    );
  }
} catch (error) {
  console.error("clx: " + error.message);
  process.exitCode = 1;
}
