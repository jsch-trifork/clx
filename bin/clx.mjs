#!/usr/bin/env node
import { spawn, execFile } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { StoreError } from "../src/store.mjs";
import { initializeCatalog, setupLocation } from "../src/setup.mjs";
import { startServer } from "../src/server.mjs";

const appDir = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const help = `CLX — Claude Code launcher and skill constellation\n\n  clx ui [--no-open] [--port 0] [--config-dir PATH]\n  clx init [--force] [--config-dir PATH] [--claude-config-dir PATH]\n  clx [preset name]    Launch Claude in this terminal\n\nUI saves use the same presets.json as the terminal launcher.\nRequires Node 20+. Terminal launch/discovery also needs zsh, jq, gum and Claude Code.\nConfig: CLX_DIR, CLX_CATALOG, CLX_PRESETS; default ~/.claude/clx.\n`;
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
  else if (["ui", "init"].includes(args[0])) {
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
    if (command === "init") {
      await initializeCatalog(
        catalogFile,
        values["claude-config-dir"],
        values.force,
      );
      console.log(`CLX catalog ready: ${catalogFile}`);
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
              await initializeCatalog(catalogFile, request.directory, true);
            } finally {
              scanning = false;
            }
          }
          return setupLocation(catalogFile);
        },
        onLaunch: async (name) => {
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
              'for dependency in gum jq claude; do command -v "$dependency" >/dev/null || { print -ru2 -- "Missing dependency: $dependency"; exit 1; }; done',
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
                CLX_CATALOG: catalogFile,
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
        `\nCLX constellation\n${url}\n\nPresets: ${presetsFile}\nKeep this terminal open. Press Ctrl+C to stop.\n`,
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
        CLX_BOOTSTRAP:
          process.env.CLX_BOOTSTRAP || join(appDir, "bootstrap.zsh"),
      },
    );
  }
} catch (error) {
  console.error("clx: " + error.message);
  process.exitCode = 1;
}
