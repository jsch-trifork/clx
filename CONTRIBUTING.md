# Contributing

Use Node 20+ and the setup in README.md. Keep actual catalogs, presets, prompts, credentials, screenshots of personal configurations, and machine-specific paths out of commits. Test fixtures must be synthetic.

Before a release, run the Node, shell, browser and formatting checks. Build with `npm pack`, inspect the archive file list, then install that archive into a temporary prefix and run `clx init` against an empty temporary user directory. The fresh catalog must have no plugins, no MCP servers, and no personal presets. Verify `clx ui` starts from that installation.

Publish the tested archive as a GitHub release asset. Do not include `node_modules`, generated local configuration, old private Git history, or developer notes. Third-party font/icon licenses must remain in the archive.

When editing the UI, preserve skill selection semantics, keyboard navigation, reduced-motion behavior, and the distinction between saved selections and unsaved changes. Include a focused browser check for changed interactions.

## Pull requests

All changes to `main` must go through a pull request. Direct pushes, force pushes, and deletion of `main` are blocked, including for the repository owner. All four Linux/macOS CI checks must pass and review conversations must be resolved.

The repository owner reviews every file through `.github/CODEOWNERS`. New commits dismiss earlier approvals. The owner has a PR-only review bypass for self-authored PRs, since GitHub does not permit authors to approve their own work. This exception does not bypass CI or permit direct pushes.

## Automated releases

A push to `main` publishes a GitHub release only after all four CI matrix jobs pass. Pull requests and other branches cannot publish. The release job has its own `contents: write` permission; test jobs remain read-only.

The job serializes publishing, skips commits that already have a stable release, and skips a run if its commit is no longer the tip of `main`. If several merges arrive together, the newest successful main run releases their combined changes. Failed CI never publishes; rerun a failed release job after correcting the failure.

The next version is the highest published stable version plus one patch, or `package.json`'s version if that is higher. To start a new minor or major series, update both package.json and package-lock.json in a PR. Otherwise, source versions remain the development baseline: the job stamps the release version into its temporary checkout without committing to `main`.

The release contains a built `.tgz` archive and `clx-SHA256SUMS.txt`, with generated notes. The archive is installed and smoke-tested against an empty user directory before publishing. Nothing is published to npm. A draft or conflicting tag with the chosen version stops publishing for maintainer inspection rather than overwriting assets. To recover an interrupted publication, inspect the draft/tag, remove only the incomplete release/tag if appropriate, and rerun the release job.
