// clx workspace helper, called from clx.zsh.
//   list    <workspaces.json>                → one workspace name per line
//   show    <workspaces.json>                → "name  ·  start folder (+N)" per workspace, for menus
//   get     <workspaces.json> <name>         → the workspace's entry as JSON
//   set     <workspaces.json> <name> <entry.json>  → checks and saves an entry (creates or replaces)
//   rename  <workspaces.json> <old> <new>
//   delete  <workspaces.json> <name>
//   mcp     <workspaces.json> <name>         → MCP servers the workspace allows, one per line
//   apply   <workspaces.json> <name> <settings.json> [protected paths...]
//           → merges the workspace's rules into settings.json and prints the start
//             folder, then the added folders, one per line. Protected paths (clx's
//             own temp files) are denied to Claude's edit tools.
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  readWorkspaces,
  resolveWorkspace,
  workspaceSettings,
  mergeSettings,
  saveWorkspace,
  renameWorkspace,
  deleteWorkspace,
} from "../src/workspaces.mjs";

const [command, file, name, arg, ...rest] = process.argv.slice(2);
try {
  const config = await readWorkspaces(file);
  if (command === "list") {
    for (const key of Object.keys(config.workspaces)) console.log(key);
  } else if (command === "show") {
    for (const [key, entry] of Object.entries(config.workspaces)) {
      const more = entry.dirs?.length ? ` (+${entry.dirs.length})` : "";
      console.log(`${key}  ·  ${basename(entry.start ?? "?")}${more}`);
    }
  } else if (command === "get") {
    const entry = config.workspaces[name];
    if (!entry) throw new Error(`No workspace named '${name}'.`);
    console.log(JSON.stringify(entry, null, 2));
  } else if (command === "set") {
    let entry;
    try {
      entry = JSON.parse(await readFile(arg, "utf8"));
    } catch {
      throw new Error("That isn't valid JSON.");
    }
    await saveWorkspace(file, name, entry);
  } else if (command === "rename") {
    await renameWorkspace(file, name, arg);
  } else if (command === "delete") {
    await deleteWorkspace(file, name);
  } else if (command === "mcp") {
    for (const server of resolveWorkspace(config, name).mcp)
      console.log(server);
  } else if (command === "apply") {
    const settingsFile = arg;
    const ws = resolveWorkspace(config, name);
    // `clx --chrome` lifts the browser block for this launch only.
    if (process.env.CLX_WORKSPACE_CHROME === "1") ws.chrome = true;
    const base = JSON.parse((await readFile(settingsFile, "utf8")) || "{}");
    const extra = await workspaceSettings(ws, {
      claudeDir: process.env.CLAUDE_CONFIG_DIR || undefined,
      guard: new URL("./workspace-guard.mjs", import.meta.url).pathname,
      protect: [settingsFile, ...rest],
    });
    const merged = mergeSettings(base, extra);
    // Commands listed here would run outside the sandbox; none may in a workspace.
    merged.sandbox.excludedCommands = [];
    await writeFile(settingsFile, JSON.stringify(merged, null, 2));
    console.log([ws.start, ...ws.dirs].join("\n"));
  } else {
    throw new Error(
      "Usage: workspace.mjs list|show FILE | get|delete|mcp FILE NAME | set FILE NAME ENTRY.json | rename FILE OLD NEW | apply FILE NAME SETTINGS [PROTECTED...]",
    );
  }
} catch (error) {
  console.error(`clx: ${error.message}`);
  process.exitCode = 1;
}
