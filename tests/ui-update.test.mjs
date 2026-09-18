import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
  realpath,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  newer,
  version,
  latestRelease,
  versionCheck,
  installation,
  installArgs,
  update,
  updateCommand,
} from "../src/update.mjs";
import { startServer } from "../src/server.mjs";

const name = "clx-constellation-1.2.3.tgz";
const base = "https://github.com/jsch-trifork/clx/releases/download/v1.2.3/";
const data = Buffer.from("fixture archive");
const digest = createHash("sha256").update(data).digest("hex");
function fetcher({ hash = digest, mutate = () => {} } = {}) {
  return async (url) => {
    if (url.endsWith("/latest")) {
      const release = {
        tag_name: "v1.2.3",
        assets: [name, "clx-SHA256SUMS.txt"].map((name) => ({
          name,
          browser_download_url: base + name,
        })),
      };
      mutate(release);
      return new Response(JSON.stringify(release));
    }
    if (url.endsWith(".txt")) return new Response(`${hash}  ${name}\n`);
    if (url === base + name) return new Response(data);
    throw Error("Unexpected URL");
  };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "clx-updater-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prefix = join(root, "ui-app"),
    directory = join(prefix, "node_modules", "clx-constellation");
  await mkdir(directory, { recursive: true });
  return { root, kind: "local", prefix, directory };
}
test("numeric stable versions and version flags work without a catalog", async () => {
  assert(newer("0.1.10", "0.1.9"));
  assert(!newer("1.2.3", "1.2.3"));
  assert(!newer("1.2.3", "2.0.0"));
  assert(!newer("2.0.0-beta", "1.0.0"));
  const run = promisify(execFile);
  for (const args of [
    ["bin/clx.mjs", "--version"],
    ["bin/clx.mjs", "-v"],
  ])
    assert.equal(
      (await run(process.execPath, args)).stdout.trim(),
      `clx ${version}`,
    );
  assert.equal(
    (await run("zsh", ["-c", "source ./clx.zsh; clx --version"])).stdout.trim(),
    `clx ${version}`,
  );
});
test("detect local and source installs; pin alternate global prefix", async (t) => {
  const target = await fixture(t);
  assert.equal(
    (await installation(target.directory)).prefix,
    await realpath(target.prefix),
  );
  assert.equal((await installation(target.root)).kind, "source");
  assert.deepEqual(
    installArgs({ kind: "global", prefix: "/custom/node" }, "/tmp/release.tgz"),
    [
      "install",
      "--global",
      "--prefix",
      "/custom/node",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "/tmp/release.tgz",
    ],
  );
  assert.throws(
    () => installArgs({ kind: "source" }, "file"),
    /source checkout/,
  );
});
test("release validates stable version and official asset URLs", async () => {
  assert.equal((await latestRelease(fetcher())).latest, "1.2.3");
  await assert.rejects(
    latestRelease(
      fetcher({
        mutate: (r) =>
          (r.assets[0].browser_download_url = "https://example.com/bad.tgz"),
      }),
    ),
    /not ready/,
  );
  await assert.rejects(
    latestRelease(fetcher({ mutate: (r) => (r.prerelease = true) })),
    /stable/,
  );
});
test("offline checks fail quietly and cache the request once per UI server", async () => {
  let calls = 0;
  const check = versionCheck({
    target: { kind: "global" },
    fetcher: async () => {
      calls++;
      throw Error("offline");
    },
  });
  const [a, b] = await Promise.all([check(), check()]);
  assert.equal(calls, 1);
  assert.equal(a.unavailable, true);
  assert.equal(b.available, false);
});
test("verified install targets the running local copy and preserves user files", async (t) => {
  const target = await fixture(t);
  for (const file of ["presets.json", "profiles.json", "loadout.json"])
    await writeFile(join(target.root, file), `private ${file}`);
  let archivePath;
  await update({
    current: "1.0.0",
    target,
    fetcher: fetcher(),
    log: () => {},
    install: async (args) => {
      assert.deepEqual(args.slice(0, -1), [
        "install",
        "--prefix",
        target.prefix,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ]);
      archivePath = args.at(-1);
      assert.deepEqual(await readFile(archivePath), data);
    },
  });
  assert.deepEqual(await readFile(archivePath), data);
  for (const file of ["presets.json", "profiles.json", "loadout.json"])
    assert.equal(
      await readFile(join(target.root, file), "utf8"),
      `private ${file}`,
    );
});
test("checksum mismatch and network failure never invoke npm", async (t) => {
  const target = await fixture(t);
  let called = false;
  for (const f of [
    fetcher({ hash: "0".repeat(64) }),
    async () => {
      throw Error("offline");
    },
  ])
    await assert.rejects(
      update({
        current: "1.0.0",
        target,
        fetcher: f,
        install: async () => {
          called = true;
        },
        log: () => {},
      }),
    );
  assert.equal(called, false);
});
test("no downgrade or reinstall when current is equal or newer", async (t) => {
  const target = await fixture(t);
  for (const current of ["1.2.3", "2.0.0"])
    await update({
      current,
      target,
      fetcher: fetcher(),
      log: () => {},
      install: async () => assert.fail("unexpected installation"),
    });
});
test("legacy wrapper gets backed up and forwarded; custom wrappers are untouched", async (t) => {
  const target = await fixture(t),
    path = join(target.root, "clx.zsh");
  const old =
    "clx() { # ui-app/node_modules/clx-constellation/bin/clx.mjs\n}\n";
  await writeFile(path, old);
  assert.match(await updateCommand(target), /^node .* update$/);
  await update({ current: "1.2.3", target, fetcher: fetcher(), log: () => {} });
  assert.match(
    await readFile(path, "utf8"),
    /source.*clx-constellation\/clx.zsh/,
  );
  const backup = (await readdir(target.root)).find((n) =>
    n.includes(".before-update-"),
  );
  assert.equal(await readFile(join(target.root, backup), "utf8"), old);
  assert.equal(await updateCommand(target), "clx update");
  await writeFile(path, "# my own wrapper");
  await update({ current: "1.2.3", target, fetcher: fetcher(), log: () => {} });
  assert.equal(await readFile(path, "utf8"), "# my own wrapper");
});
test("failed npm install preserves the legacy wrapper", async (t) => {
  const target = await fixture(t),
    path = join(target.root, "clx.zsh");
  const old =
    "clx() { # ui-app/node_modules/clx-constellation/bin/clx.mjs\n}\n";
  await writeFile(path, old);
  let archive;
  await assert.rejects(
    update({
      current: "1.0.0",
      target,
      fetcher: fetcher(),
      log: () => {},
      install: async (args) => {
        archive = args.at(-1);
        throw Error("denied");
      },
    }),
    /Installation failed/,
  );
  assert.equal(await readFile(path, "utf8"), old);
  assert.deepEqual(await readFile(archive), data);
});
test("version API is authenticated and works even before initialization", async (t) => {
  const { server, url } = await startServer({
    onVersion: versionCheck({
      current: "1.0.0",
      target: { kind: "global" },
      fetcher: fetcher(),
    }),
  });
  t.after(() => new Promise((r) => server.close(r)));
  const endpoint = new URL("/api/version", url);
  assert.equal((await fetch(endpoint)).status, 401);
  const result = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${new URL(url).hash.slice(1)}` },
  });
  const info = await result.json();
  assert.equal(info.available, true);
  assert.equal(info.command, "clx update");
});

test("real npm installation upgrades only the detected local or global prefix", async (t) => {
  const root = (await fixture(t)).root;
  const staging = join(root, "staging");
  await mkdir(join(staging, "package"), { recursive: true });
  await writeFile(
    join(staging, "package", "package.json"),
    JSON.stringify({
      name: "clx-constellation",
      version: "1.2.3",
      bin: { clx: "cli.mjs" },
    }),
  );
  await writeFile(
    join(staging, "package", "cli.mjs"),
    '#!/usr/bin/env node\nconsole.log("clx 1.2.3");\n',
    { mode: 0o755 },
  );
  const run = promisify(execFile);
  const tarball = join(root, name);
  await run("tar", ["-czf", tarball, "-C", staging, "package"]);
  const bytes = await readFile(tarball);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const metadata = fetcher({ hash });
  const releaseFetch = async (url) =>
    url === base + name ? new Response(bytes) : metadata(url);
  for (const kind of ["local", "global"]) {
    const prefix = join(root, kind);
    const directory = join(
      prefix,
      ...(kind === "global" ? ["lib"] : []),
      "node_modules",
      "clx-constellation",
    );
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ name: "clx-constellation", version: "1.0.0" }),
    );
    const target = { kind, prefix, directory };
    await update({
      current: "1.0.0",
      target,
      fetcher: releaseFetch,
      log: () => {},
      install: (args) =>
        run("npm", args, {
          env: {
            ...process.env,
            npm_config_cache: join(root, "cache"),
            npm_config_offline: "true",
          },
        }),
    });
    assert.equal(
      JSON.parse(await readFile(join(directory, "package.json"))).version,
      "1.2.3",
    );
    if (kind === "local") {
      await run(
        "npm",
        [
          "install",
          "--prefix",
          prefix,
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
        ],
        {
          env: {
            ...process.env,
            npm_config_cache: join(root, "cache"),
            npm_config_offline: "true",
          },
        },
      );
    }
    assert.equal(
      (
        await run(process.execPath, [join(directory, "cli.mjs"), "--version"])
      ).stdout.trim(),
      "clx 1.2.3",
    );
  }
});
