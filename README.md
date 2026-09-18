# CLX — Claude Code skill constellation

A local visual interface and terminal launcher for choosing Claude Code skills, plugins, models, and MCP servers. Create presets, edit their skill selections on an interactive constellation, and launch a session with that configuration.

**Bring your own Claude Code installation and plugins.** CLX contains no bundled skill library, personal presets, prompts, credentials, or hosted account. Your first preset library is empty.

## Prerequisites

Install these tools before using CLX:

| Requirement | What it is needed for | Check in your terminal |
| --- | --- | --- |
| **Node.js 20 or newer and npm** | Installing CLX and running the local UI | `node --version` and `npm --version` |
| **zsh** | Discovering your configuration and running the launcher | `zsh --version` |
| **jq** | Reading and updating the launcher's JSON configuration | `jq --version` |
| **gum** | The terminal preset picker and launcher controls | `gum --version` |
| **Claude Code CLI, installed and signed in** | Starting Claude sessions with your chosen preset | `claude --version`, then run `claude` to complete sign-in if needed |
| **A web browser** | Viewing and editing presets in the constellation UI | Open the local URL printed by `clx ui` |

**Supported environments:** macOS and Linux. On Windows, install and run the tools inside **WSL**. Keep the terminal running while using the browser UI.

### Set up the tools

- Install [Node.js with npm](https://nodejs.org/en/download), version 20 or newer.
- On **macOS**, if you use Homebrew, install the shell tools with:

  ```sh
  brew install zsh jq gum
  ```

- On **Linux or WSL**, install `zsh` and `jq` through your distribution's package manager, then follow [gum's installation instructions](https://github.com/charmbracelet/gum#installation).
- Install and sign into [Claude Code](https://code.claude.com/docs/en/setup) with your own account or provider configuration.

Run the checks above in the same terminal where you will run CLX. Each command must be available on your `PATH`; a “command not found” message means that tool still needs installation or shell configuration.

### Optional: skills and integrations

**You do not need existing presets to start.** CLX opens with an empty preset library and lets you create your first preset in the UI.

Install your own skill-bearing Claude Code plugins if you want skills to appear in the constellation. CLX does not bundle or install plugins; without them, you can still create a model-only preset. MCP servers are optional and require their own setup if you use them. **Git is only required if you choose the source installation below.**

## Install CLX

Download the `.tgz` archive from the [latest release](https://github.com/jsch-trifork/clx/releases/latest). In a directory containing only that CLX archive, run:

```sh
npm install -g ./clx-constellation-*.tgz
clx init
cd /path/to/your/project
clx ui
```

Alternatively, build from source:

```sh
git clone https://github.com/jsch-trifork/clx.git
cd clx
npm ci
npm pack
npm install -g ./clx-constellation-*.tgz
clx init
```

The npm install builds local fonts and icons; the release archive already includes them. This project is not published to the npm registry: use the release archive or source instructions above.

If a previous shell function named `clx` shadows the installed command, remove its old source line from your shell configuration or run `command clx ui`.

To update, download the latest archive and run the install command again. Your local presets and catalog are preserved. Releases are published on GitHub, not the npm registry.

## First use

1. Install the Claude Code plugins you want using Claude Code's plugin manager. CLX does not install plugins.
2. Run `clx init` to discover skill-bearing plugins registered in your user settings and their installed skill directories. A family is one plugin; its nodes are the skills it actually contains.
3. Run `clx ui` from the project where you want Claude to work. Open the token-bearing local URL printed in the terminal if a browser does not open automatically.
4. On first use, choose **Create a preset**, give it a name, then click skills to include them. **Save** keeps the preset; **Cancel** returns to the welcome screen. Later, use **+** for additional presets and preset settings to change the model.
5. Use **Launch in terminal** in the preset picker, or run `clx "Your preset"` in a terminal.

With no plugins, the interface starts with an empty constellation. You can still create presets for a model or configured integrations. Install plugins and run `clx init --force`, then reload the UI, to populate the map. Loose skills in `~/.claude/skills` or project folders are outside CLX's plugin selection controls and may still load through Claude Code itself.

## Claude profiles and shared presets

A **profile** chooses the Claude configuration folder and executable. A **preset** chooses skills, model, and integrations. Presets are shared: use the same Investigate or Design preset for different customers without copying it.

In `clx ui`, use the profile selector at the top, then **Add profile**. Give it a name, the configuration folder containing `settings.json` and `plugins/`, and either `claude` (found on `PATH`) or an absolute executable path. CLX scans the folder when you save. Existing installations appear as **Default**, keeping their catalog and presets.

For an alias such as:

```sh
alias claude-customer='CLAUDE_CONFIG_DIR=/path/to/customer/claude /path/to/bin/claude'
```

Create a profile named **Customer A**, with `/path/to/customer/claude` as its configuration folder and `/path/to/bin/claude` as its executable. Enter the two paths separately; do not paste a shell alias or command into the executable field.

- Run `clx`: with multiple profiles, choose the profile first, then a shared preset. A single profile skips the profile prompt.
- Run `clx ui`: choose a profile in the UI and switch with the selector. Save or discard unsaved preset edits before switching.
- Choose explicitly in scripts or shortcuts:

  ```sh
  clx --profile "Customer A" "Investigate"
  clx ui --profile "Customer A"
  clx init --profile "Customer A" --force
  ```

A preset may reference skills or integrations absent from a profile. CLX lists them before launch and requires an explicit choice to continue without them. The UI also offers choosing another profile. This does not rewrite the saved preset. Matching uses plugin IDs and skill directory names, not labels. Whole-plugin selections use that profile's installed version and contents.

Profile changes are local to each running CLX UI session. Editing or deleting a profile does not delete its Claude configuration, credentials, or shared presets. Switch away from a profile before deleting it; at least one profile must remain.

### Initial setup or a different configuration folder

If no catalog is available, the UI offers a **Claude configuration folder** field and **Scan this folder**. For an empty skill map, use **Choose Claude folder**; you can also change the current profile's folder from the preset menu. CLX uses the saved location, `CLAUDE_CONFIG_DIR`, or `~/.claude` as its starting point.

```sh
clx init --claude-config-dir "/path/to/claude-work" --force
clx ui
```

`--config-dir` means **where CLX stores its own shared presets and profiles**; `--claude-config-dir` means **which Claude configuration to discover**. Custom profiles read their own `.claude.json` for MCP discovery. The default `~/.claude` profile retains the usual `~/.claude.json` location. CLX does not copy credentials or change profile configuration files.

## Using the UI

- **View:** click a family to expand its tree and reveal all skill names. Click a skill for details beside its dot on desktop or in a bottom sheet on mobile.
- **Edit:** click a skill to toggle it directly. Filled dots are selected; hollow dots are not. **+** and **−** markers distinguish unsaved additions and removals.
- **Save / Cancel:** commit your draft or restore the saved preset. Leaving with changes offers Save or Discard.
- **Family centre:** select the whole plugin, all skills only, or none. Whole plugin includes its hooks and agents; selecting individual skills excludes those plugin extras.
- **Preset settings:** rename, choose the model and effort, configure MCP/other plugins, or delete the preset. Deleting a preset never deletes installed skills.
- **Navigation:** drag or use the arrows to pan. The overview remains wide on narrow screens so nodes do not overlap. Every preset appears in the scrolling bottom bar.

Motion respects reduced-motion preferences and pauses in hidden tabs. No fonts or scripts are fetched from a CDN.

Prompt editing in the UI is deferred. The terminal's `clx prompts` command manages your local prompt files; existing prompt references survive UI saves.

## Configuration and privacy

CLX defaults to `~/.claude/clx` **on the current user's machine**:

| File | Purpose |
| --- | --- |
| `loadout.json` | Discovered plugin paths, model aliases, and local MCP configuration |
| `presets.json` | Saved presets shared across all profiles |
| `profiles.json` | Local profile names, configuration folders, and executable paths |
| `profile-catalogs/` | Discovered catalog for each additional profile |
| `prompts/` | Your optional prompt files |
| `.preset-backups/` | Last 20 versions written by the UI |

These files are not distributed with the app. **Do not share your generated catalog:** MCP configuration can contain credentials. Only MCP names—not command arguments or environment secrets—are sent to the browser. Skill descriptions and preset selections are visible in the local UI.

`clx init` reads your Claude settings, plugin registry/cache, and MCP configuration. It requires no API key and makes no network requests. MCP discovery merges global and configured project entries; review the integration names before selecting them. Models use Claude Code's [provider-resolved aliases](https://code.claude.com/docs/en/model-config); availability still depends on your account/provider. You can edit model entries in your local catalog.

The server binds to `127.0.0.1` and requires a per-run browser token. CLX has no analytics or hosted service. Launching Claude or your selected plugins/integrations uses those tools' own network behavior and permissions.

```sh
clx init --force                 # regenerate catalog after plugin changes
clx ui --no-open                 # print the local URL without opening it
clx ui --port 4318
clx ui --config-dir /path/to/config
clx "Your preset"               # exact name, or an unambiguous partial name
clx                             # terminal preset picker
```

`CLX_DIR`, `CLX_CATALOG`, `CLX_PRESETS`, and `CLX_PROMPTS_DIR` override local paths. Explicit catalog/preset variables take precedence over the config directory.

The launcher uses temporary files and symlinks rather than changing your global Claude settings. Plugins absent from the catalog and loose skills can remain active through Claude's own settings. Refresh the catalog after changing plugins.

## Troubleshooting

- **No catalog:** run `clx init`. Existing catalogs are preserved unless `--force` is passed.
- **No skills:** install skill-bearing plugins in Claude Code and refresh the catalog. CLX does not ship the author's plugins or presets.
- **Missing skill files:** run `clx init --force`, then choose Reload from disk in the preset picker.
- **Launch dependency missing:** ensure `zsh`, `jq`, `gum`, and `claude` are on PATH in the terminal running CLX.
- **A session is already running:** finish that session before launching another from the same UI process.
- **Save conflict:** another process changed the preset file. Reload and reapply the draft. Stale saves are refused rather than overwriting newer changes.
- **Restore a preset:** stop CLX and copy the desired file from `.preset-backups` over `presets.json`.

## Development

```sh
npm ci
npm test
npm run test:shell
npx playwright install chromium
npm run test:browser
npm run format:check
npm pack
```

The tests generate synthetic catalogs and temporary configurations; no developer's real skills or presets are needed. CI runs on Linux and macOS. See [CONTRIBUTING.md](CONTRIBUTING.md) for release checks.

## License

MIT. Bundled fonts and icons retain their third-party licenses in `web/vendor` inside the built package. Claude Code and any plugins you install are separate products under their own terms. This is an independent project, not an Anthropic product.
