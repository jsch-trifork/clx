import {
  readFile,
  writeFile,
  mkdtemp,
  mkdir,
  rm,
  copyFile,
  rename,
  realpath,
} from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
export const appDirectory = fileURLToPath(new URL("../", import.meta.url));
export const version = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url)),
).version;
const releases = "https://github.com/jsch-trifork/clx/releases";
const api = "https://api.github.com/repos/jsch-trifork/clx/releases/latest";
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function newer(candidate, current) {
  if (!stable.test(candidate) || !stable.test(current)) return false;
  const a = candidate.split(".").map(Number),
    b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
export async function installation(directory = appDirectory) {
  const path = await realpath(directory);
  if (
    basename(path) !== "clx-constellation" ||
    basename(dirname(path)) !== "node_modules"
  )
    return { kind: "source", directory: path };
  const parent = dirname(dirname(path));
  // Ask the active npm first: do not accidentally update another Node installation.
  let globalRoot;
  try {
    globalRoot = (
      await exec("npm", ["root", "-g"], { timeout: 3000 })
    ).stdout.trim();
  } catch {
    /* local installs still work */
  }
  if (
    globalRoot &&
    (await realpath(globalRoot).catch(() => "")) === dirname(path)
  )
    return { kind: "global", directory: path };
  if (basename(parent) === "lib")
    return { kind: "global", prefix: dirname(parent), directory: path };
  return { kind: "local", prefix: parent, directory: path };
}
export async function legacyWrapper(target) {
  if (target.kind !== "local" || basename(target.prefix) !== "ui-app")
    return null;
  const path = join(dirname(target.prefix), "clx.zsh");
  const contents = await readFile(path, "utf8").catch(() => "");
  if (
    !contents.includes("ui-app/node_modules/clx-constellation/bin/clx.mjs") ||
    !contents.includes("clx()")
  )
    return null;
  return { path, contents };
}
export async function updateCommand(target) {
  return (await legacyWrapper(target))
    ? `node ${quote(join(target.directory, "bin/clx.mjs"))} update`
    : "clx update";
}
async function response(url, fetcher = fetch) {
  const result = await fetcher(url, {
    signal: AbortSignal.timeout(10000),
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "clx-updater",
    },
  });
  if (!result.ok)
    throw new Error(`GitHub returned ${result.status}. Try again later.`);
  return result;
}
export async function latestRelease(fetcher = fetch) {
  const release = await (await response(api, fetcher)).json();
  const latest = release.tag_name?.replace(/^v/, "");
  if (!stable.test(latest || "") || release.draft || release.prerelease)
    throw new Error("No stable CLX release is available.");
  const name = `clx-constellation-${latest}.tgz`;
  const archiveUrl = `${releases}/download/v${latest}/${name}`;
  const checksumUrl = `${releases}/download/v${latest}/clx-SHA256SUMS.txt`;
  for (const [assetName, url] of [
    [name, archiveUrl],
    ["clx-SHA256SUMS.txt", checksumUrl],
  ]) {
    if (
      !release.assets?.some(
        (a) => a.name === assetName && a.browser_download_url === url,
      )
    )
      throw new Error("The release is not ready yet. Try again later.");
  }
  return {
    latest,
    name,
    archiveUrl,
    checksumUrl,
    releaseUrl: `${releases}/tag/v${latest}`,
  };
}
export function versionCheck({
  current = version,
  target,
  fetcher = fetch,
} = {}) {
  let pending;
  return () =>
    (pending ??= (async () => {
      const install = target || (await installation());
      const base = {
        current,
        command: await updateCommand(install),
        source: install.kind === "source",
      };
      try {
        const release = await latestRelease(fetcher);
        return {
          ...base,
          latest: release.latest,
          available: newer(release.latest, current),
          releaseUrl: release.releaseUrl,
        };
      } catch {
        return { ...base, available: false, unavailable: true };
      }
    })());
}
export function installArgs(target, archive) {
  if (target.kind === "source")
    throw new Error(
      "This is a source checkout. Pull the latest main branch and run npm ci, or install a release archive.",
    );
  return [
    "install",
    ...(target.kind === "global" ? ["--global"] : []),
    ...(target.prefix ? ["--prefix", target.prefix] : []),
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    archive,
  ];
}
export async function update({
  current = version,
  target,
  fetcher = fetch,
  install = async (args) => exec("npm", args, { maxBuffer: 4 * 1024 * 1024 }),
  log = console.log,
} = {}) {
  target ||= await installation();
  installArgs(target, ""); // Refuse source checkouts before making a network request.
  const release = await latestRelease(fetcher);
  if (newer(release.latest, current)) {
    const temp = await mkdtemp(join(tmpdir(), "clx-update-"));
    try {
      log(`Updating CLX ${current} → ${release.latest}…`);
      const checksum = await (
        await response(release.checksumUrl, fetcher)
      ).text();
      const line = checksum
        .split(/\r?\n/)
        .find((l) => l.trim().split(/\s+/)[1] === release.name);
      const expected = line?.trim().split(/\s+/)[0];
      if (!/^[a-f0-9]{64}$/i.test(expected || ""))
        throw new Error(
          "Release checksum is missing or invalid. Nothing was installed.",
        );
      const data = Buffer.from(
        await (await response(release.archiveUrl, fetcher)).arrayBuffer(),
      );
      if (
        createHash("sha256").update(data).digest("hex") !==
        expected.toLowerCase()
      )
        throw new Error(
          "Release checksum does not match. Nothing was installed.",
        );
      let archive = join(temp, release.name);
      await writeFile(archive, data);
      if (target.kind === "local") {
        // npm records file dependencies in package.json/package-lock.json. Keep
        // the verified archive so later npm installs do not reference deleted temp files.
        const cache = join(target.prefix, ".clx-releases");
        await mkdir(cache, { recursive: true });
        const saved = join(cache, release.name);
        await copyFile(archive, saved);
        archive = saved;
      }
      try {
        await install(installArgs(target, archive));
      } catch (error) {
        throw new Error(
          `Installation failed. Check npm permissions and retry clx update. ${error.stderr?.trim() || error.message}`,
        );
      }
      log(`Installed CLX ${release.latest}.`);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  } else log(`CLX ${current} is up to date.`);
  const wrapper = await legacyWrapper(target);
  if (wrapper) {
    // Only migrate the known legacy wrapper, keeping an exact backup beside it.
    const backup = `${wrapper.path}.before-update-${Date.now()}`;
    await copyFile(wrapper.path, backup);
    const next = `${wrapper.path}.updating`;
    await writeFile(
      next,
      '# CLX compatibility wrapper.\nsource "${${(%):-%x}:A:h}/ui-app/node_modules/clx-constellation/clx.zsh"\n',
      { mode: 0o600 },
    );
    await rename(next, wrapper.path);
    log(
      `Updated the legacy shell wrapper. Backup: ${backup}\nOpen a new terminal before using clx update.`,
    );
  }
  log(
    "Presets and profiles are unchanged. Restart clx ui and open its new URL.",
  );
}
