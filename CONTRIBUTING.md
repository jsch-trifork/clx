# Contributing

Use Node 20+ and the setup in README.md. Keep actual catalogs, presets, prompts, credentials, screenshots of personal configurations, and machine-specific paths out of commits. Test fixtures must be synthetic.

Before a release, run the Node, shell, browser and formatting checks. Build with `npm pack`, inspect the archive file list, then install that archive into a temporary prefix and run `clx init` against an empty temporary user directory. The fresh catalog must have no plugins, no MCP servers, and no personal presets. Verify `clx ui` starts from that installation.

Publish the tested archive as a GitHub release asset. Do not include `node_modules`, generated local configuration, old private Git history, or developer notes. Third-party font/icon licenses must remain in the archive.

When editing the UI, preserve skill selection semantics, keyboard navigation, reduced-motion behavior, and the distinction between saved selections and unsaved changes. Include a focused browser check for changed interactions.

## Pull requests

All changes to `main` must go through a pull request. Direct pushes, force pushes, and deletion of `main` are blocked, including for the repository owner. All four Linux/macOS CI checks must pass and review conversations must be resolved.

The repository owner reviews every file through `.github/CODEOWNERS`. New commits dismiss earlier approvals. The owner has a PR-only review bypass for self-authored PRs, since GitHub does not permit authors to approve their own work. This exception does not bypass CI or permit direct pushes.
