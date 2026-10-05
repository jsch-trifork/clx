# Workspaces: `clx -w NAME <preset>` and the Workspace menu scope the launch —
# claude starts in the workspace folder with sandbox + deny rules in --settings.

() {
  local work=$(mktemp -d) out=$(mktemp -d) stub=$(mktemp -d)
  work=${work:A}
  mkdir -p "$work/home/code/org/present" "$work/home/code/org/ui" "$work/home/code/other" "$work/sk/work-next"

  local cat="$work/loadout.json" pf="$work/presets.json" wf="$work/workspaces.json"
  jq -n --arg d "$work/sk/work-next" '{
      models: [ {id:"claude-sonnet-4-6", label:"Sonnet"} ],
      mcpServers: { context7: {command:"npx", args:["c7"], env:{}}, playwright: {command:"npx", args:["pw"], env:{}} },
      skillPlugins: [ {id:"workflow@example-skills", name:"am", skills:[ {dir:$d, label:"work-next — nav"} ]} ],
      otherPlugins: []
    }' > "$cat"
  jq -n '{p1:{model:"claude-sonnet-4-6",skillPlugins:{},otherPlugins:[],mcp:["context7","playwright"]}}' > "$pf"
  jq -n '{fence:["~/code"], workspaces:{present:{start:"~/code/org/present", dirs:["~/code/org/ui"], mcp:["context7"]}}}' > "$wf"

  # claude stub: record argv, cwd and the generated settings.
  cat > "$stub/claude" <<EOF
#!/bin/zsh
emulate -L zsh
if [[ "\$1" == --version ]]; then cat "$out/version"; exit 0; fi
print -r -- "\$*" > "$out/argv"
pwd > "$out/cwd"
print -r -- "\${ENABLE_CLAUDEAI_MCP_SERVERS:-unset}" > "$out/connectors"
local i=1; while (( i <= \$# )); do
  [[ "\${@[i]}" == --settings ]] && cp "\${@[i+1]}" "$out/s.json"
  [[ "\${@[i]}" == --mcp-config ]] && cp "\${@[i+1]}" "$out/m.json"
  (( i++ ))
done
exit 0
EOF
  chmod +x "$stub/claude"

  # gum stub: menu answers keyed by header; every header is logged.
  cat > "$stub/gum" <<EOF
#!/bin/zsh
emulate -L zsh
[[ "\$1" == choose ]] && cat >/dev/null
local header=""
while (( \$# )); do case "\$1" in --header) header="\$2"; shift 2;; --selected) shift 2;; *) shift;; esac; done
print -r -- "\$header" >> "$out/menus"
case "\$header" in
  "Preset:")    print -r -- "p1" ;;
  "Preset '"*)  print -r -- "use as-is" ;;
  "Workspace:") cat "$out/ws_choice" ;;
esac
exit 0
EOF
  chmod +x "$stub/gum"

  print -r -- "2.1.281 (Claude Code)" > "$out/version"
  local here=$PWD
  local -x HOME="$work/home" CLX_CATALOG="$cat" CLX_PRESETS="$pf" CLX_WORKSPACES="$wf"

  # --- Direct: clx -w present p1 ---
  ( PATH="$stub:$PATH"; clx -w present p1 >/dev/null 2>&1 )
  assert_eq "ws_direct_exit" "$?" "0"
  assert_eq "ws_direct_cwd" "$(<"$out/cwd")" "$work/home/code/org/present"
  assert_eq "ws_caller_cwd_unchanged" "$PWD" "$here"
  assert_eq "ws_sandbox_on" "$(jq -r '.sandbox.enabled' "$out/s.json")" "true"
  assert_eq "ws_no_escape" "$(jq -r '.sandbox.allowUnsandboxedCommands' "$out/s.json")" "false"
  assert_eq "ws_other_denied" \
    "$(jq -r --arg r "Read(/$work/home/code/other/**)" '.permissions.deny | index($r) != null' "$out/s.json")" "true"
  assert_json_eq "ws_added_dir" "$(jq -c '.permissions.additionalDirectories' "$out/s.json")" "[\"$work/home/code/org/ui\"]"
  assert_eq "ws_add_dir_flag" "$([[ "$(<"$out/argv")" == *"--add-dir $work/home/code/org/ui"* ]] && echo yes)" "yes"
  # Chrome is on by default in workspaces; the rest stays locked.
  assert_eq "ws_chrome_default_on" "$([[ "$(<"$out/argv")" == *"--chrome"* && "$(<"$out/argv")" != *"--no-chrome"* ]] && echo yes)" "yes"
  assert_eq "ws_chrome_default_not_denied" "$(jq '.permissions.deny | index("mcp__claude-in-chrome") == null' "$out/s.json")" "true"
  assert_json_eq "ws_mcp_filtered" "$(jq -c '.mcpServers|keys' "$out/m.json")" '["context7"]'
  assert_eq "ws_connectors_off" "$(<"$out/connectors")" "false"
  assert_eq "ws_guard_hook" "$(jq -r '.hooks.PreToolUse[0].matcher' "$out/s.json")" "Agent"
  assert_eq "ws_no_menus_when_direct" "$([[ -f "$out/menus" ]] && echo menus)" ""

  # --- Chrome default on, with a note; --no-chrome locks it for one launch ---
  ( PATH="$stub:$PATH"; clx -w present p1 >/dev/null 2>"$out/chrome_err" )
  assert_eq "ws_chrome_rest_locked" "$(jq '.permissions.deny | index("RemoteTrigger") != null' "$out/s.json")" "true"
  assert_eq "ws_chrome_sandbox" "$(jq -r '.sandbox.enabled' "$out/s.json")" "true"
  assert_eq "ws_chrome_notes" "$(grep -c 'Chrome is on' "$out/chrome_err")" "1"
  ( PATH="$stub:$PATH"; clx -w present --no-chrome p1 >/dev/null 2>"$out/chrome_err" )
  assert_eq "ws_no_chrome_exit" "$?" "0"
  assert_eq "ws_no_chrome_flag" "$([[ "$(<"$out/argv")" == *"--no-chrome"* ]] && echo yes)" "yes"
  assert_eq "ws_no_chrome_denied" "$(jq '.permissions.deny | index("mcp__claude-in-chrome") != null' "$out/s.json")" "true"
  assert_eq "ws_no_chrome_quiet" "$(grep -c 'Chrome is on' "$out/chrome_err")" "0"
  ( PATH="$stub:$PATH"; clx -w present p1 >/dev/null 2>&1 )
  assert_eq "ws_chrome_back_on_next_launch" "$(jq '.permissions.deny | index("mcp__claude-in-chrome") == null' "$out/s.json")" "true"

  # --- Direct without -w: unscoped, no workspace menu ---
  rm -f "$out/s.json"
  ( PATH="$stub:$PATH"; cd "$work"; clx p1 >/dev/null 2>&1 )
  assert_eq "ws_unscoped_cwd" "$(<"$out/cwd")" "$work"
  # Normal sessions without a flag follow Claude Code's own Chrome setting.
  assert_eq "ws_unscoped_no_chrome_flag" "$([[ "$(<"$out/argv")" == *"chrome"* ]] && echo yes)" ""
  assert_json_eq "ws_unscoped_mcp_kept" "$(jq -c '.mcpServers|keys' "$out/m.json")" '["context7","playwright"]'
  assert_eq "ws_unscoped_connectors" "$(<"$out/connectors")" "unset"
  assert_eq "ws_unscoped_no_sandbox" "$(jq -r '.sandbox // "none"' "$out/s.json")" "none"

  # --- Menus: Workspace menu picks 'present' ---
  print -r -- "present" > "$out/ws_choice"
  ( PATH="$stub:$PATH"; clx >/dev/null 2>&1 )
  assert_eq "ws_menu_exit" "$?" "0"
  assert_eq "ws_menu_shown" "$(grep -c '^Workspace:$' "$out/menus")" "1"
  assert_eq "ws_menu_cwd" "$(<"$out/cwd")" "$work/home/code/org/present"

  # --- Launch fetches workspace clones, so the session sees new remote commits ---
  local remote="$work/remote.git" pusher="$work/pusher" present="$work/home/code/org/present"
  git init -q --bare "$remote"
  git -C "$present" init -q && git -C "$present" remote add origin "$remote"
  git clone -q "$remote" "$pusher" 2>/dev/null
  git -C "$pusher" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "new on remote"
  git -C "$pusher" push -q origin HEAD:main 2>/dev/null
  ( PATH="$stub:$PATH"; clx -w present p1 >"$out/fetch_stdout" 2>&1 )
  assert_eq "ws_fetch_exit" "$?" "0"
  assert_eq "ws_fetched_remote" "$(git -C "$present" rev-parse origin/main 2>/dev/null)" "$(git -C "$pusher" rev-parse HEAD)"
  assert_eq "ws_fetch_reported" "$(grep -c 'fetched present' "$out/fetch_stdout")" "1"
  assert_eq "ws_non_git_skipped" "$(grep -c 'fetched ui' "$out/fetch_stdout")" "0"

  # --- Claude Code too old (or version unreadable) for workspaces: refuse to launch ---
  rm -f "$out/argv"
  print -r -- "2.1.100 (Claude Code)" > "$out/version"
  ( PATH="$stub:$PATH"; clx -w present p1 >/dev/null 2>"$out/old_err" )
  assert_eq "ws_old_claude_fails" "$?" "1"
  assert_eq "ws_old_claude_no_launch" "$([[ -f "$out/argv" ]] && echo launched)" ""
  assert_eq "ws_old_claude_says_why" "$(grep -c 'too old for workspaces' "$out/old_err")" "1"
  print -r -- "garbage" > "$out/version"
  ( PATH="$stub:$PATH"; clx -w present p1 >/dev/null 2>&1 )
  assert_eq "ws_unknown_version_fails" "$?" "1"
  print -r -- "2.2.0 (Claude Code)" > "$out/version"
  ( PATH="$stub:$PATH"; clx -w present p1 >/dev/null 2>&1 )
  assert_eq "ws_newer_claude_ok" "$?" "0"
  # Unscoped launches don't need the check.
  print -r -- "2.1.100 (Claude Code)" > "$out/version"
  ( PATH="$stub:$PATH"; clx p1 >/dev/null 2>&1 )
  assert_eq "ws_old_claude_unscoped_ok" "$?" "0"

  # --- Unknown workspace fails before launching ---
  rm -f "$out/argv"
  ( PATH="$stub:$PATH"; clx --workspace=nope p1 >/dev/null 2>&1 )
  assert_eq "ws_unknown_fails" "$?" "1"
  assert_eq "ws_unknown_no_launch" "$([[ -f "$out/argv" ]] && echo launched)" ""

  rm -rf "$work" "$out" "$stub"
}

# Project skills: listed from each folder and its parents, up to the git root
# (or home outside a repo); personal skills in ~/.claude/skills are not listed.
() {
  local home=$(mktemp -d)
  home=${home:A}
  local -x HOME="$home"
  local sk
  for sk in outer/.claude/skills/outer-skill outer/app/.claude/skills/app-skill \
            outer/repo/.claude/skills/repo-skill .claude/skills/personal-skill; do
    mkdir -p "$home/$sk" && print -r -- "---" > "$home/$sk/SKILL.md"
  done
  mkdir -p "$home/outer/.claude/skills/not-a-skill"   # no SKILL.md
  git -C "$home/outer/repo" init -q

  assert_eq "skills_walk_up_outside_repo" "$(_clx_project_skills "$home/outer/app")" \
    "clx: project skills from app: app-skill, outer-skill"
  assert_eq "skills_stop_at_git_root" "$(_clx_project_skills "$home/outer/repo")" \
    "clx: project skills from repo: repo-skill"
  assert_eq "skills_none_quiet" "$(_clx_project_skills "$home")" ""

  # The launcher prints them for the folder it starts in.
  local stub=$(mktemp -d)
  printf '#!/bin/sh\nexit 0\n' > "$stub/claude"; printf '#!/bin/sh\ncat >/dev/null; exit 0\n' > "$stub/gum"
  chmod +x "$stub/claude" "$stub/gum"
  local cat="$home/loadout.json" pf="$home/presets.json"
  jq -n '{models:[{id:"m",label:"M"}], mcpServers:{}, skillPlugins:[], otherPlugins:[]}' > "$cat"
  jq -n '{p1:{model:"m",skillPlugins:{},otherPlugins:[],mcp:[]}}' > "$pf"
  local shown
  shown=$( cd "$home/outer/repo"; PATH="$stub:$PATH" CLX_CATALOG="$cat" CLX_PRESETS="$pf" clx p1 2>/dev/null )
  assert_eq "skills_on_launch" "$(print -r -- "$shown" | grep -c '^clx: project skills from repo: repo-skill$')" "1"
  rm -rf "$home" "$stub"
}

# clx workspaces: create, edit, rename and delete through the menus (gum scripted).
() {
  local work=$(mktemp -d) stub=$(mktemp -d)
  work=${work:A}
  mkdir -p "$work/home/code/app" "$work/home/code/lib"
  local wf="$work/workspaces.json" cat="$work/loadout.json" ans="$work/answers"
  mkdir -p "$ans"
  jq -n '{models:[{id:"m",label:"M"}], mcpServers:{context7:{},playwright:{}}, skillPlugins:[], otherPlugins:[]}' > "$cat"

  # gum stub: each header has a queue of answers (one per line), consumed in order.
  cat > "$stub/gum" <<EOF
#!/bin/zsh
emulate -L zsh
local sub="\$1"; shift
[[ "\$sub" == choose ]] && cat >/dev/null
[[ "\$sub" == confirm ]] && exit 0
local header=""
while (( \$# )); do case "\$1" in --header) header="\$2"; shift 2;; *) shift;; esac; done
local key="\${header//[^A-Za-z]/}"
local n=\$(( \$(cat "$ans/\$key.n" 2>/dev/null || echo 0) + 1 ))
print -r -- \$n > "$ans/\$key.n"
sed -n "\${n}p" "$ans/\$key" 2>/dev/null
EOF
  chmod +x "$stub/gum"
  q() { local key="${1//[^A-Za-z]/}"; shift; print -rl -- "$@" > "$ans/$key"; rm -f "$ans/$key.n"; }

  local -x HOME="$work/home" CLX_WORKSPACES="$wf" CLX_CATALOG="$cat"
  local mcp_header="MCP servers this workspace may use (they run outside the sandbox; none = off):"

  # Create: name, start, extra folders, MCP.
  q "Workspaces:" "+ new workspace" "— done —"
  q "Workspace name:" "demo"
  q "Start folder (Claude starts here):" "~/code/app"
  q "Extra folders, comma-separated (empty for none):" "~/code/lib"
  q "$mcp_header" "context7"
  ( PATH="$stub:$PATH"; clx workspaces >"$work/out" 2>&1 )
  assert_eq "wsm_create_exit" "$?" "0"
  assert_json_eq "wsm_created" "$(jq -c '.workspaces.demo' "$wf")" '{"start":"~/code/app","dirs":["~/code/lib"],"mcp":["context7"]}'
  assert_eq "wsm_create_hint" "$(grep -c 'clx -w demo' "$work/out")" "1"

  # Edit folders and MCP: drop the extra folder and all MCP; other settings are kept.
  jq '.workspaces.demo.github = true' "$wf" > "$wf.tmp" && mv "$wf.tmp" "$wf"
  q "Workspaces:" "demo  ·  app (+1)" "— done —"
  q "Workspace 'demo':" "edit folders and MCP servers"
  q "Start folder (Claude starts here):" "~/code/app"
  q "Extra folders, comma-separated (empty for none):" ""
  q "$mcp_header" ""
  ( PATH="$stub:$PATH"; clx workspaces >/dev/null 2>&1 )
  assert_json_eq "wsm_edited" "$(jq -c '.workspaces.demo' "$wf")" '{"start":"~/code/app","github":true}'

  # A missing folder is refused and the saved workspace is unchanged.
  q "Workspaces:" "demo  ·  app" "— done —"
  q "Workspace 'demo':" "edit folders and MCP servers"
  q "Start folder (Claude starts here):" "~/code/missing"
  q "Extra folders, comma-separated (empty for none):" ""
  q "$mcp_header" ""
  ( PATH="$stub:$PATH"; clx workspaces >/dev/null 2>"$work/err" )
  assert_eq "wsm_bad_folder_said" "$(grep -c 'Folder not found' "$work/err")" "1"
  assert_eq "wsm_bad_folder_unchanged" "$(jq -r '.workspaces.demo.start' "$wf")" "~/code/app"

  # Edit all settings in $EDITOR: an invalid edit is refused and reopened; the fix saves.
  cat > "$work/editor" <<EOF
#!/bin/zsh
local n=\$(( \$(cat "$work/editor.n" 2>/dev/null || echo 0) + 1 )); print -r -- \$n > "$work/editor.n"
if (( n == 1 )); then print -r -- '{"start":"~/code/app","chrome":true}' > "\$1"
else print -r -- '{"start":"~/code/app","network":["api.nuget.org"]}' > "\$1"; fi
EOF
  chmod +x "$work/editor"
  q "Workspaces:" "demo  ·  app" "— done —"
  q "Workspace 'demo':" "edit all settings in editor"
  ( PATH="$stub:$PATH"; EDITOR="$work/editor" VISUAL= clx workspaces >/dev/null 2>"$work/err" )
  assert_eq "wsm_editor_refused_typo" "$(grep -c "Unknown workspace setting 'chrome'" "$work/err")" "1"
  assert_eq "wsm_editor_reopened" "$(<"$work/editor.n")" "2"
  assert_json_eq "wsm_editor_saved" "$(jq -c '.workspaces.demo' "$wf")" '{"start":"~/code/app","network":["api.nuget.org"]}'

  # Rename, then delete.
  q "Workspaces:" "demo  ·  app" "— done —"
  q "Workspace 'demo':" "rename"
  q "New name for 'demo':" "demo2"
  ( PATH="$stub:$PATH"; clx workspaces >/dev/null 2>&1 )
  assert_eq "wsm_renamed" "$(jq -r '.workspaces | keys | join(",")' "$wf")" "demo2"
  q "Workspaces:" "demo2  ·  app" "— done —"
  q "Workspace 'demo2':" "delete"
  ( PATH="$stub:$PATH"; clx workspaces >/dev/null 2>&1 )
  assert_eq "wsm_deleted" "$(jq -r '.workspaces | length' "$wf")" "0"
  assert_eq "wsm_folders_kept" "$([[ -d "$work/home/code/app" ]] && echo yes)" "yes"

  unfunction q
  rm -rf "$work" "$stub"
}
