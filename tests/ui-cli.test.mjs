import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
test("npm CLI passes preset names as arguments rather than shell source", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "clx-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, "argv.json"),
    fake = join(dir, "zsh");
  await writeFile(
    fake,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.CLX_TEST_OUTPUT,JSON.stringify(process.argv.slice(2)))\n`,
  );
  await chmod(fake, 0o755);
  const name = "Preset ' with $(no-execution) spaces";
  await exec(process.execPath, ["bin/clx.mjs", name], {
    env: {
      ...process.env,
      PATH: dir + ":" + process.env.PATH,
      CLX_TEST_OUTPUT: output,
    },
  });
  const argv = JSON.parse(await readFile(output));
  assert.equal(argv.at(-1), name);
  assert.equal(argv[1], 'source "$1"; shift; clx "$@"');
});
test("sourced launcher dispatches clx ui before terminal dependency checks", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "clx-dispatch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, "argv.json"),
    fake = join(dir, "node");
  await writeFile(
    fake,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.CLX_TEST_OUTPUT,JSON.stringify(process.argv.slice(2)))\n`,
  );
  await chmod(fake, 0o755);
  await exec(
    "/bin/zsh",
    ["-c", 'source "$1"; clx ui --no-open', "test", resolve("clx.zsh")],
    {
      env: {
        ...process.env,
        PATH: dir + ":" + process.env.PATH,
        CLX_TEST_OUTPUT: output,
      },
    },
  );
  const args = JSON.parse(await readFile(output));
  assert.equal(args[0], resolve("bin/clx.mjs"));
  assert.deepEqual(args.slice(1), ["ui", "--no-open"]);
});
