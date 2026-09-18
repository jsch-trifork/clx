import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
const pkg = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url)),
);
const archive = resolve(process.argv[2] || `${pkg.name}-${pkg.version}.tgz`);
const dir = await mkdtemp(join(tmpdir(), "clx-package-"));
let server;
try {
  const prefix = join(dir, "install"),
    home = join(dir, "user");
  await mkdir(home);
  const { stdout: files } = await exec("tar", ["-tzf", archive]);
  assert(
    !/package\/(?:presets\.json|loadout\.json|profiles\.json|profile-catalogs\/|prompts\/|lab\/|docs\/|\.git\/)/m.test(
      files,
    ),
  );
  for (const file of [
    "web/core.js",
    "web/vendor/inter.woff2",
    "web/vendor/lucide-LICENSE.txt",
    "LICENSE",
  ])
    assert(files.includes("package/" + file));
  await exec(
    "npm",
    [
      "install",
      "--prefix",
      prefix,
      archive,
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    { timeout: 120000 },
  );
  const cli = join(prefix, "node_modules/clx-constellation/bin/clx.mjs");
  const config = join(home, ".claude/clx");
  const env = { PATH: process.env.PATH, HOME: home };
  await exec(process.execPath, [cli, "init"], { env });
  const catalog = JSON.parse(await readFile(join(config, "loadout.json")));
  assert.deepEqual(catalog.skillPlugins, []);
  assert.deepEqual(catalog.mcpServers, {});
  server = spawn(process.execPath, [cli, "ui", "--no-open"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = await new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(
      () => reject(new Error("UI startup timed out")),
      10000,
    );
    server.once("error", reject);
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`UI exited early: ${code}`));
    });
    server.stdout.on("data", (chunk) => {
      out += chunk;
      const match = out.match(/http:\/\/127\.0\.0\.1:\d+\/#\w+/);
      if (match) {
        clearTimeout(timer);
        resolve(new URL(match[0]));
      }
    });
  });
  const stateResponse = await fetch(new URL("/api/state", url), {
    headers: { Authorization: `Bearer ${url.hash.slice(1)}` },
  });
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.deepEqual(state.presets, []);
  assert.deepEqual(state.families, []);
  assert.equal((await fetch(new URL("/vendor/inter.woff2", url))).status, 200);
  assert.equal((await fetch(new URL("/api/state", url))).status, 401);
  console.log(
    "Release archive installs independently; empty-user init, authenticated UI, bundled assets and privacy checks passed.",
  );
} finally {
  if (server && server.exitCode === null) {
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await stopped;
  }
  await rm(dir, { recursive: true, force: true });
}
