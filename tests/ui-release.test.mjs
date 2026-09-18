import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { nextVersion } from "../scripts/release.mjs";

test("release versions advance from published versions, not the source baseline", () => {
  assert.equal(nextVersion("0.1.0", ["v0.1.0", "v0.1.1"]), "0.1.2");
  assert.equal(nextVersion("0.1.0", ["v0.1.9", "v0.1.10", "v0.1.2"]), "0.1.11");
  assert.equal(nextVersion("0.1.0", ["v0.2.0-beta.1", "unrelated"]), "0.1.0");
});

test("release execution refuses PRs, other branches, and forks", () => {
  for (const override of [
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_REF: "refs/heads/feature" },
    { GH_REPO: "someone/clx" },
  ]) {
    const result = spawnSync(process.execPath, ["scripts/release.mjs"], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GH_REPO: "jsch-trifork/clx",
        GITHUB_SHA: "test-commit",
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF: "refs/heads/main",
        ...override,
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /upstream main push workflow/);
  }
});

test("a reviewed version bump can start a new minor or major series", () => {
  assert.equal(nextVersion("0.2.0", ["v0.1.8"]), "0.2.0");
  assert.equal(nextVersion("1.0.0", ["v0.2.8"]), "1.0.0");
  assert.equal(nextVersion("0.1.0", []), "0.1.0");
  assert.throws(() => nextVersion("invalid", []), /stable semantic version/);
});
