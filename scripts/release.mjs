import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const stable = /^v?(\d+)\.(\d+)\.(\d+)$/;
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const parse = (version) => stable.exec(version)?.slice(1).map(Number);

export function nextVersion(baseline, tags) {
  const base = parse(baseline);
  if (!base)
    throw new Error("package.json must have a stable semantic version");
  const versions = tags.map(parse).filter(Boolean).sort(compare);
  const latest = versions.at(-1);
  if (!latest) return base.join(".");
  const next = [latest[0], latest[1], latest[2] + 1];
  return (compare(base, next) > 0 ? base : next).join(".");
}

function release() {
  const {
    GH_REPO: repo,
    GITHUB_SHA: sha,
    GITHUB_EVENT_NAME,
    GITHUB_REF,
  } = process.env;
  if (
    repo !== "jsch-trifork/clx" ||
    !sha ||
    GITHUB_EVENT_NAME !== "push" ||
    GITHUB_REF !== "refs/heads/main"
  ) {
    throw new Error("Releases must run from the upstream main push workflow");
  }
  const run = (cmd, args) =>
    execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }).trim();
  const api = (path) => JSON.parse(run("gh", ["api", path]));
  if (run("git", ["rev-parse", "HEAD"]) !== sha)
    throw new Error("Checkout does not match tested commit");
  if (api(`repos/${repo}/commits/main`).sha !== sha) {
    console.log(
      "A newer main commit exists; its successful CI run will publish.",
    );
    return;
  }
  const releases = JSON.parse(
    run("gh", [
      "api",
      "--paginate",
      "--slurp",
      `repos/${repo}/releases?per_page=100`,
    ]),
  ).flat();
  const published = releases.filter(
    (r) => !r.draft && !r.prerelease && stable.test(r.tag_name),
  );
  for (const item of published) {
    if (run("git", ["rev-list", "-n", "1", item.tag_name]) === sha) {
      console.log(`This commit is already released as ${item.tag_name}.`);
      return;
    }
  }
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const version = nextVersion(
    pkg.version,
    published.map((r) => r.tag_name),
  );
  const tag = `v${version}`;
  if (
    releases.some((r) => r.tag_name === tag) ||
    run("git", ["tag", "--list", tag])
  ) {
    throw new Error(
      `${tag} already exists; inspect the incomplete release/tag before retrying`,
    );
  }
  run("npm", [
    "version",
    version,
    "--no-git-tag-version",
    "--allow-same-version",
  ]);
  run("npm", ["pack"]);
  const archive = `${pkg.name}-${version}.tgz`;
  run(process.execPath, ["scripts/smoke-package.mjs", archive]);
  const digest = createHash("sha256")
    .update(readFileSync(archive))
    .digest("hex");
  writeFileSync("clx-SHA256SUMS.txt", `${digest}  ${archive}\n`);
  if (api(`repos/${repo}/commits/main`).sha !== sha) {
    console.log(
      "Main advanced during packaging; leaving publication to its CI run.",
    );
    return;
  }
  console.log(
    run("gh", [
      "release",
      "create",
      tag,
      archive,
      "clx-SHA256SUMS.txt",
      "--repo",
      repo,
      "--target",
      sha,
      "--title",
      `CLX ${tag}`,
      "--generate-notes",
      "--latest",
    ]),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  release();
