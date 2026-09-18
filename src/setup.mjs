import { readFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { StoreError } from "./store.mjs";

const exec = promisify(execFile);
const bootstrap = fileURLToPath(new URL("../bootstrap.zsh", import.meta.url));
export async function setupLocation(catalogFile) {
  let saved;
  try {
    saved = JSON.parse(await readFile(catalogFile, "utf8")).claudeConfigDir;
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  return {
    directory:
      saved || process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
  };
}

export async function initializeCatalog(catalogFile, directory, force = false) {
  if (
    directory !== undefined &&
    (typeof directory !== "string" || !directory.trim())
  )
    throw new StoreError(
      "Enter the Claude configuration folder containing settings.json and plugins.",
    );
  const env = { ...process.env };
  if (directory !== undefined) {
    const value = directory.trim();
    const path = resolve(
      value === "~"
        ? homedir()
        : value.startsWith("~/")
          ? join(homedir(), value.slice(2))
          : value,
    );
    if (!(await stat(path).catch(() => null))?.isDirectory())
      throw new StoreError(
        "That folder does not exist. Enter the folder containing your Claude settings.json and plugins.",
      );
    env.CLAUDE_CONFIG_DIR = path;
  }
  await mkdir(dirname(catalogFile), { recursive: true });
  try {
    await exec("zsh", [bootstrap, catalogFile, ...(force ? ["--force"] : [])], {
      env,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    throw new StoreError(
      error.stderr?.trim() ||
        "Could not read Claude configuration. Check the folder and that zsh and jq are installed.",
    );
  }
}
