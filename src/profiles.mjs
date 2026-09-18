import {
  readFile,
  writeFile,
  mkdir,
  rename,
  open,
  unlink,
  stat,
  access,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { setupLocation, initializeCatalog } from "./setup.mjs";
import { StoreError } from "./store.mjs";

export class Profiles {
  constructor(dir, catalogFile) {
    this.dir = dir;
    this.defaultCatalog = catalogFile;
    this.file = join(dir, "profiles.json");
    this.activeId = "default";
  }
  async list() {
    let bytes;
    try {
      bytes = await readFile(this.file, "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const profiles = bytes
      ? JSON.parse(bytes)
      : [
          {
            id: "default",
            name: "Default",
            directory: (await setupLocation(this.defaultCatalog)).directory,
            executable: "claude",
          },
        ];
    if (
      !Array.isArray(profiles) ||
      !profiles.length ||
      profiles.some(
        (p) =>
          !/^(default|[a-f0-9-]{36})$/.test(p.id) ||
          typeof p.name !== "string" ||
          typeof p.directory !== "string" ||
          typeof p.executable !== "string",
      ) ||
      new Set(profiles.map((p) => p.id)).size !== profiles.length
    )
      throw new StoreError(
        "Invalid profiles.json. Restore it before continuing.",
        422,
      );
    return {
      profiles,
      persisted: Boolean(bytes),
      activeId: this.activeId,
      revision: createHash("sha256")
        .update(bytes || JSON.stringify(profiles))
        .digest("hex"),
    };
  }
  async current() {
    const { profiles } = await this.list();
    const p = profiles.find((p) => p.id === this.activeId);
    if (!p)
      throw new StoreError(
        "This profile was removed. Choose another profile.",
        409,
      );
    return p;
  }
  async verifyCatalog() {
    const current = await this.current();
    let catalog;
    try {
      catalog = JSON.parse(await readFile(this.catalog(), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (
      catalog.claudeConfigDir &&
      resolve(catalog.claudeConfigDir) !== resolve(current.directory)
    )
      throw new StoreError(
        "This profile's catalog points to a different Claude folder. Edit and save the profile to rescan before launching.",
        409,
      );
  }
  catalog(id = this.activeId) {
    if (!/^(default|[a-f0-9-]{36})$/.test(id))
      throw new StoreError("Invalid profile.");
    return id === "default"
      ? this.defaultCatalog
      : join(this.dir, "profile-catalogs", id + ".json");
  }
  async select(id) {
    const { profiles } = await this.list();
    const p = profiles.find((p) => p.id === id || p.name === id);
    if (!p) throw new StoreError("Choose an existing Claude profile.", 404);
    try {
      await stat(this.catalog(p.id));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      await initializeCatalog(this.catalog(p.id), p.directory, true);
    }
    this.activeId = p.id;
    return this.list();
  }
  async mutate(request) {
    await mkdir(this.dir, { recursive: true });
    let lock;
    try {
      lock = await open(this.file + ".lock", "wx", 0o600);
    } catch (e) {
      if (e.code === "EEXIST")
        throw new StoreError(
          "Another profile change is in progress. Try again.",
          409,
        );
      throw e;
    }
    let temp;
    try {
      const state = await this.list();
      if (request.revision !== state.revision)
        throw new StoreError(
          "Profiles changed. Reopen the profile selector and try again.",
          409,
        );
      let profiles = state.profiles;
      if (request.operation === "delete") {
        if (profiles.length === 1)
          throw new StoreError("Keep at least one Claude profile.");
        if (request.id === this.activeId)
          throw new StoreError(
            "Switch to another profile before deleting this one.",
          );
        if (!profiles.some((p) => p.id === request.id))
          throw new StoreError("Profile no longer exists.", 404);
        profiles = profiles.filter((p) => p.id !== request.id);
      } else if (["create", "update"].includes(request.operation)) {
        const name = request.name?.trim();
        if (
          !name ||
          name.length > 80 ||
          name.startsWith("-") ||
          /[\x00-\x1f\x7f]/.test(name)
        )
          throw new StoreError("Enter a profile name of 1–80 characters.");
        if (
          profiles.some(
            (p) =>
              p.name.toLowerCase() === name.toLowerCase() &&
              p.id !== request.id,
          )
        )
          throw new StoreError("A profile already has that name.");
        if (typeof request.directory !== "string" || !request.directory.trim())
          throw new StoreError("Enter a Claude configuration folder.");
        const expand = (v) =>
          resolve(v.startsWith("~/") ? join(homedir(), v.slice(2)) : v);
        const directory = expand(request.directory.trim());
        let executable = request.executable?.trim() || "claude";
        if (executable !== "claude") {
          if (!isAbsolute(executable) && !executable.startsWith("~/"))
            throw new StoreError(
              "Use an absolute executable path, or claude to use PATH. Shell aliases and arguments are not supported.",
            );
          executable = expand(executable);
          if (!(await stat(executable).catch(() => null))?.isFile())
            throw new StoreError("Claude executable must be a file.");
          try {
            await access(executable, constants.X_OK);
          } catch {
            throw new StoreError("Claude executable is not executable.");
          }
        }
        const id = request.operation === "create" ? randomUUID() : request.id;
        if (
          request.operation === "update" &&
          !profiles.some((p) => p.id === id)
        )
          throw new StoreError("Profile no longer exists.", 404);
        // Scanning succeeds before the profile registry changes. Presets are never touched.
        await initializeCatalog(this.catalog(id), directory, true);
        const value = { id, name, directory, executable };
        profiles =
          request.operation === "create"
            ? [...profiles, value]
            : profiles.map((p) => (p.id === id ? value : p));
      } else throw new StoreError("Unknown profile operation.");
      temp = this.file + "." + randomUUID() + ".tmp";
      await writeFile(temp, JSON.stringify(profiles, null, 2) + "\n", {
        mode: 0o600,
      });
      await rename(temp, this.file);
      return this.list();
    } finally {
      if (temp) await unlink(temp).catch(() => {});
      await lock.close();
      await unlink(this.file + ".lock");
    }
  }
}
