# Integration test: run the real clx() end-to-end with gum + claude stubbed.
# Catches bugs in the clx() body that the pure-helper unit tests cannot reach
# (e.g. bad parameter substitutions, mktemp templates, arg composition).

() {
  local work=$(mktemp -d) out=$(mktemp -d) stub=$(mktemp -d)

  # Real skill dirs so subset symlinks have valid targets.
  mkdir -p "$work/am/skills/work-next" "$work/am/skills/work-plan" "$work/sp/skills/brainstorming"

  # Catalog: am (skillPlugin, 2 skills), superpowers (skillPlugin, 1), swift-lsp (otherPlugin), 1 mcp server.
  local cat="$work/loadout.json"
  jq -n \
    --arg amwn "$work/am/skills/work-next" \
    --arg amwp "$work/am/skills/work-plan" \
    --arg spbr "$work/sp/skills/brainstorming" '{
      models: [ {id:"claude-sonnet-4-6", label:"Sonnet 4.6 (fast; default)"},
                {id:"claude-opus-4-8", label:"Opus 4.8"} ],
      mcpServers: { playwright: {command:"npx", args:["-y","playwright-mcp"], env:{}} },
      skillPlugins: [
        {id:"workflow@example-skills", name:"am",
         skills:[ {dir:$amwn, label:"work-next — nav"}, {dir:$amwp, label:"work-plan — plan"} ]},
        {id:"superpowers@claude-plugins-official", name:"superpowers",
         skills:[ {dir:$spbr, label:"brainstorming — ideas"} ]}
      ],
      otherPlugins: [ {id:"swift-lsp@claude-plugins-official", name:"swift-lsp"} ]
    }' > "$cat"

  # Deterministic gum selections, one file per menu (matched by --header text).
  print -r -- "work-next — nav"      > "$out/sel_am"     # am: subset of one skill
  print -r -- "(all superpowers)"    > "$out/sel_sp"     # superpowers: all -> enable real
  print -r -- "swift-lsp"            > "$out/sel_other"  # other: enable
  print -r -- "playwright"           > "$out/sel_mcp"    # mcp: one server

  # gum stub: model menu uses --selected (echo it); multi-selects keyed by header.
  cat > "$stub/gum" <<EOF
#!/bin/zsh
emulate -L zsh
# Read piped choices like gum does; avoid producer SIGPIPE under pipefail.
[[ "\$1" == choose ]] && cat >/dev/null
local header="" selected="" a
while (( \$# )); do
  case "\$1" in
    --selected) selected="\$2"; shift 2 ;;
    --header)   header="\$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [[ -n "\$selected" ]]; then print -r -- "\$selected"; exit 0; fi
case "\$header" in
  "am —"*)            cat "$out/sel_am" ;;
  "superpowers —"*)   cat "$out/sel_sp" ;;
  "Other plugins"*)   cat "$out/sel_other" ;;
  "MCP servers"*)     cat "$out/sel_mcp" ;;
  *) : ;;
esac
exit 0
EOF
  chmod +x "$stub/gum"

  # claude stub: capture argv + copy the --settings/--mcp-config files (clx deletes them after).
  cat > "$stub/claude" <<EOF
#!/bin/zsh
emulate -L zsh
print -r -- "\$*" > "$out/argv"
local i=1
while (( i <= \$# )); do
  case "\${@[i]}" in
    --settings)   cp "\${@[i+1]}" "$out/settings.json" ;;
    --mcp-config) cp "\${@[i+1]}" "$out/mcp.json" ;;
  esac
  (( i++ ))
done
exit 0
EOF
  chmod +x "$stub/claude"

  # Isolated HOME: clx deep-merges the user's real ~/.claude/settings.json into the
  # generated enabledPlugins, so a real settings.json listing plugins outside this
  # catalog would leak into the assertion below. Give it a controlled one instead.
  mkdir -p "$work/home/.claude"
  print -r -- '{"theme":"dark"}' > "$work/home/.claude/settings.json"

  # jq must stay real; only gum and claude are stubbed.
  local rc
  ( PATH="$stub:$PATH"; HOME="$work/home" CLX_CATALOG="$cat" clx >"$out/stdout" 2>/dev/null )
  rc=$?

  assert_eq "int_exit_zero" "$rc" "0"
  # stdout must be clean — no leaked local-redeclaration dumps (e.g. raw_labels=...).
  assert_eq "int_stdout_no_leak" "$(grep -c 'raw_labels' "$out/stdout")" "0"

  local argv; argv=$(<"$out/argv" 2>/dev/null)
  assert_eq "int_has_model"   "$([[ "$argv" == *"--model claude-sonnet-4-6"* ]] && echo yes)" "yes"
  assert_eq "int_strict_mcp"  "$([[ "$argv" == *"--strict-mcp-config"* ]] && echo yes)"       "yes"
  assert_eq "int_plugin_dir"  "$([[ "$argv" == *"--plugin-dir"* ]] && echo yes)"              "yes"

  # enabledPlugins: am subset -> false; superpowers (all) -> true; swift-lsp (other) -> true.
  assert_json_eq "int_enabled_plugins" \
    "$(jq -c '.enabledPlugins' "$out/settings.json")" \
    '{"workflow@example-skills":false,"superpowers@claude-plugins-official":true,"swift-lsp@claude-plugins-official":true}'

  # mcp config: only the selected server.
  assert_json_eq "int_mcp" \
    "$(jq -c '.mcpServers | keys' "$out/mcp.json")" \
    '["playwright"]'

  rm -rf "$work" "$out" "$stub"
}

() {
  local work=$(mktemp -d) out=$(mktemp -d) stub=$(mktemp -d)
  mkdir -p "$work/am/skills/work-next" "$work/am/skills/work-plan"
  local cat="$work/loadout.json" pf="$work/presets.json"
  jq -n --arg amwn "$work/am/skills/work-next" --arg amwp "$work/am/skills/work-plan" '{
    models:[{id:"claude-sonnet-4-6",label:"Sonnet 4.6 (fast; default)"},{id:"claude-opus-4-8",label:"Opus 4.8"}],
    mcpServers:{playwright:{command:"npx",args:["-y","playwright-mcp"],env:{}}},
    skillPlugins:[{id:"workflow@example-skills",name:"am",skills:[{dir:$amwn,label:"work-next — nav"},{dir:$amwp,label:"work-plan — plan"}]}],
    otherPlugins:[]
  }' > "$cat"
  jq -n '{p1:{model:"claude-opus-4-8",skillPlugins:{"workflow@example-skills":{mode:"subset",skills:["work-next"]}},otherPlugins:[],mcp:["playwright"]}}' > "$pf"

  cat > "$stub/claude" <<EOF
#!/bin/zsh
emulate -L zsh
print -r -- "\$*" > "$out/argv"
local i=1; while (( i <= \$# )); do case "\${@[i]}" in --settings) cp "\${@[i+1]}" "$out/s.json";; --mcp-config) cp "\${@[i+1]}" "$out/m.json";; esac; (( i++ )); done
exit 0
EOF
  chmod +x "$stub/claude"

  # --- AS-IS: Preset menu -> p1 ; action -> use as-is ---
  cat > "$stub/gum" <<EOF
#!/bin/zsh
emulate -L zsh
# Read piped choices like gum does; avoid producer SIGPIPE under pipefail.
[[ "\$1" == choose ]] && cat >/dev/null
local header=""
while (( \$# )); do case "\$1" in --header) header="\$2"; shift 2;; --selected) shift 2;; *) shift;; esac; done
case "\$header" in
  "Preset:")   print -r -- "p1" ;;
  "Preset '"*) print -r -- "use as-is" ;;
  *) : ;;
esac
exit 0
EOF
  chmod +x "$stub/gum"
  ( PATH="$stub:$PATH"; CLX_CATALOG="$cat" CLX_PRESETS="$pf" clx >"$out/stdout1" 2>/dev/null )
  assert_eq "preset_asis_exit" "$?" "0"
  local argv; argv=$(<"$out/argv")
  assert_eq "preset_asis_model"  "$([[ "$argv" == *"--model claude-opus-4-8"* ]] && echo yes)" "yes"
  assert_eq "preset_asis_subset" "$([[ "$argv" == *"--plugin-dir"* ]] && echo yes)"            "yes"
  assert_json_eq "preset_asis_mcp" "$(jq -c '.mcpServers|keys' "$out/m.json")" '["playwright"]'
  assert_eq "preset_asis_noleak" "$(grep -cE 'raw_labels=|choice=' "$out/stdout1")" "0"

  # Quick changes must skip all skill/integration menus and preserve the preset.
  local before_quick=$(cat "$pf")
  cat > "$stub/gum" <<EOF
#!/bin/zsh
[[ "\$1" == choose ]] && cat >/dev/null
local header=""
while (( \$# )); do case "\$1" in --header) header="\$2"; shift 2;; --selected) shift 2;; *) shift;; esac; done
print -r -- "\$header" >> "$out/quick_menus"
case "\$header" in
  "Preset:") print -r -- p1 ;;
  "Preset '"*) print -r -- "model and effort only (this launch)" ;;
  "Model (this launch only):") print -r -- "Sonnet 4.6 (fast; default)" ;;
  "Effort (this launch only):") print -r -- high ;;
  *) exit 3 ;;
esac
EOF
  chmod +x "$stub/gum"
  ( PATH="$stub:$PATH"; CLX_CATALOG="$cat" CLX_PRESETS="$pf" clx >"$out/quick_stdout" 2>/dev/null )
  assert_eq "quick_exit" "$?" "0"
  assert_eq "quick_model" "$([[ "$(cat "$out/argv")" == *"--model claude-sonnet-4-6"* ]] && echo yes)" "yes"
  assert_eq "quick_skills" "$([[ "$(cat "$out/argv")" == *"--plugin-dir"* ]] && echo yes)" "yes"
  assert_eq "quick_effort" "$([[ "$(cat "$out/argv")" == *"--effort high"* ]] && echo yes)" "yes"
  assert_eq "quick_preset_unchanged" "$(cat "$pf")" "$before_quick"
  assert_eq "quick_only_four_menus" "$(wc -l < "$out/quick_menus" | tr -d ' ')" "4"
  assert_json_eq "quick_mcp_preserved" "$(jq -c '.mcpServers|keys' "$out/m.json")" '["playwright"]'

  # --- SAVE: blank -> menus -> save as p2 ---
  cat > "$stub/gum" <<EOF
#!/bin/zsh
emulate -L zsh
# Read piped choices like gum does; avoid producer SIGPIPE under pipefail.
[[ "\$1" == choose ]] && cat >/dev/null
local header="" selected="" cmd="\$1"
while (( \$# )); do case "\$1" in --header) header="\$2"; shift 2;; --selected) selected="\$2"; shift 2;; --placeholder) shift 2;; *) shift;; esac; done
case "\$cmd" in
  confirm) exit 0 ;;
  input)   print -r -- "p2"; exit 0 ;;
  choose)
    case "\$header" in
      "Preset:")      print -r -- "— start blank —" ;;
      "Model:")       print -r -- "Opus 4.8" ;;
      "am —"*)        print -r -- "(all am)" ;;
      "MCP servers"*) print -r -- "playwright" ;;
      *) : ;;
    esac ;;
esac
exit 0
EOF
  chmod +x "$stub/gum"
  ( PATH="$stub:$PATH"; CLX_CATALOG="$cat" CLX_PRESETS="$pf" clx >/dev/null 2>&1 )
  assert_eq "preset_saved"      "$(jq -r '.p2.model' "$pf")" "claude-opus-4-8"
  assert_eq "preset_saved_full" "$(jq -r '.p2.skillPlugins["workflow@example-skills"].mode' "$pf")" "full"

  # --- UPDATE p1 in place: Preset -> p1 ; customize ; new model ; Save changes -> Update 'p1' ---
  cat > "$stub/gum" <<EOF
#!/bin/zsh
emulate -L zsh
# Read piped choices like gum does; avoid producer SIGPIPE under pipefail.
[[ "\$1" == choose ]] && cat >/dev/null
local header="" cmd="\$1"
while (( \$# )); do case "\$1" in --header) header="\$2"; shift 2;; --selected) shift 2;; --placeholder) shift 2;; *) shift;; esac; done
case "\$cmd" in
  confirm) exit 1 ;;
  input)   exit 1 ;;
  choose)
    case "\$header" in
      "Preset:")        print -r -- "p1" ;;
      "Preset '"*)      print -r -- "customize" ;;
      "Model:")         print -r -- "Sonnet 4.6 (fast; default)" ;;
      "Effort:")        print -r -- "(default)" ;;
      "am —"*)          print -r -- "work-next — nav" ;;
      "MCP servers"*)   print -r -- "playwright" ;;
      "Save changes?")  print -r -- "Update 'p1'" ;;
      *) : ;;
    esac ;;
esac
exit 0
EOF
  chmod +x "$stub/gum"
  ( PATH="$stub:$PATH"; CLX_CATALOG="$cat" CLX_PRESETS="$pf" clx >/dev/null 2>&1 )
  assert_eq "preset_updated_model"  "$(jq -r '.p1.model' "$pf")" "claude-sonnet-4-6"
  assert_eq "preset_updated_subset" "$(jq -c '.p1.skillPlugins["workflow@example-skills"].skills' "$pf")" '["work-next"]'
  assert_eq "preset_updated_nodup"  "$(jq 'keys|length' "$pf")" "2"

  # --- DELETE p1: Preset -> p1 ; action -> delete ; confirm Delete -> yes ; then blank ; save -> no ---
  cat > "$stub/gum" <<EOF
#!/bin/zsh
emulate -L zsh
# Read piped choices like gum does; avoid producer SIGPIPE under pipefail.
[[ "\$1" == choose ]] && cat >/dev/null
local orig_args=("\$@") header="" selected="" cmd="\$1"
while (( \$# )); do case "\$1" in --header) header="\$2"; shift 2;; --selected) selected="\$2"; shift 2;; --placeholder) shift 2;; *) shift;; esac; done
[[ -n "\$selected" ]] && { print -r -- "\$selected"; exit 0; }
case "\$cmd" in
  confirm) [[ "\${orig_args[*]}" == *Delete* ]] && exit 0; exit 1 ;;
  input)   exit 1 ;;
  choose)
    case "\$header" in
      "Preset:")      [[ -f "$out/deleted" ]] && print -r -- "— start blank —" || { : > "$out/deleted"; print -r -- "p1"; } ;;
      "Preset '"*)    print -r -- "delete" ;;
      "Model:")       print -r -- "Sonnet 4.6 (fast; default)" ;;
      *) : ;;
    esac ;;
esac
exit 0
EOF
  chmod +x "$stub/gum"
  ( PATH="$stub:$PATH"; CLX_CATALOG="$cat" CLX_PRESETS="$pf" clx >/dev/null 2>&1 )
  assert_eq "preset_deleted" "$(jq 'has("p1")' "$pf")" "false"

  rm -rf "$work" "$out" "$stub"
}

# Direct invocation: `clx <preset>` must launch the preset as-is without ever
# calling gum; the preset menu must show each preset's model label.
() {
  local work=$(mktemp -d) out=$(mktemp -d) stub=$(mktemp -d)
  mkdir -p "$work/am/skills/work-next"
  local cat="$work/loadout.json" pf="$work/presets.json"
  jq -n --arg amwn "$work/am/skills/work-next" '{
    models:[{id:"claude-sonnet-4-6",label:"Sonnet 4.6 (fast; default)"},{id:"claude-opus-4-8",label:"Opus 4.8"}],
    mcpServers:{playwright:{command:"npx",args:["-y","playwright-mcp"],env:{}}},
    skillPlugins:[{id:"workflow@example-skills",name:"am",skills:[{dir:$amwn,label:"work-next — nav"}]}],
    otherPlugins:[]
  }' > "$cat"
  jq -n '{p1:{model:"claude-opus-4-8",skillPlugins:{"workflow@example-skills":{mode:"subset",skills:["work-next"]}},otherPlugins:[],mcp:["playwright"]}}' > "$pf"

  # gum stub that flags any invocation — direct launch must never call gum.
  cat > "$stub/gum" <<EOF
#!/bin/zsh
: > "$out/gum_called"
exit 1
EOF
  chmod +x "$stub/gum"
  cat > "$stub/claude" <<EOF
#!/bin/zsh
print -r -- "\$*" > "$out/argv"
local i=1; while (( i <= \$# )); do case "\${@[i]}" in --mcp-config) cp "\${@[i+1]}" "$out/m.json";; esac; (( i++ )); done
exit 0
EOF
  chmod +x "$stub/claude"

  # Exact name, and a fuzzy prefix, both launch without menus.
  ( PATH="$stub:$PATH"; CLX_CATALOG="$cat" CLX_PRESETS="$pf" clx p1 >/dev/null 2>&1 )
  assert_eq "direct_exit"      "$?" "0"
  assert_eq "direct_no_gum"    "$([[ -f "$out/gum_called" ]] && echo yes)" ""
  local argv; argv=$(<"$out/argv")
  assert_eq "direct_model"     "$([[ "$argv" == *"--model claude-opus-4-8"* ]] && echo yes)" "yes"
  assert_eq "direct_subset"    "$([[ "$argv" == *"--plugin-dir"* ]] && echo yes)"            "yes"
  assert_json_eq "direct_mcp"  "$(jq -c '.mcpServers|keys' "$out/m.json")" '["playwright"]'

  rm -f "$out/argv"
  ( PATH="$stub:$PATH"; CLX_CATALOG="$cat" CLX_PRESETS="$pf" clx P >/dev/null 2>&1 )
  assert_eq "direct_fuzzy_exit"  "$?" "0"
  assert_eq "direct_fuzzy_model" "$([[ "$(<"$out/argv")" == *"--model claude-opus-4-8"* ]] && echo yes)" "yes"

  # Unknown preset: error out, no launch.
  ( PATH="$stub:$PATH"; CLX_CATALOG="$cat" CLX_PRESETS="$pf" clx nosuch >/dev/null 2>&1 )
  assert_eq "direct_unknown_fails" "$?" "1"

  # Preset menu items carry the model label: capture the Preset menu's stdin.
  cat > "$stub/gum" <<EOF
#!/bin/zsh
emulate -L zsh
# Read piped choices like gum does; avoid producer SIGPIPE under pipefail.
local header="" selected="" cmd="\$1"
while (( \$# )); do case "\$1" in --header) header="\$2"; shift 2;; --selected) selected="\$2"; shift 2;; *) shift;; esac; done
[[ "\$cmd" == confirm ]] && exit 1
if [[ "\$header" == "Preset:" ]]; then cat > "$out/preset_menu_items"; print -r -- "— start blank —"; exit 0; fi
[[ "\$cmd" == choose ]] && cat >/dev/null
[[ -n "\$selected" ]] && print -r -- "\$selected"
exit 0
EOF
  chmod +x "$stub/gum"
  ( PATH="$stub:$PATH"; CLX_CATALOG="$cat" CLX_PRESETS="$pf" clx >/dev/null 2>&1 )
  assert_eq "menu_shows_model" \
    "$(grep -c 'p1  ·  Opus 4.8' "$out/preset_menu_items")" "1"

  rm -rf "$work" "$out" "$stub"
}

# Per-preset effort: a preset with an effort level passes --effort at launch;
# one without passes nothing; picking a level in the Effort menu saves it.
() {
  local work=$(mktemp -d) out=$(mktemp -d) stub=$(mktemp -d)
  mkdir -p "$work/am/skills/wn"
  local cat="$work/loadout.json" pf="$work/presets.json"
  jq -n --arg wn "$work/am/skills/wn" '{
    models:[{id:"claude-opus-4-8",label:"Opus 4.8"}],
    mcpServers:{},
    skillPlugins:[{id:"workflow@example-skills",name:"am",skills:[{dir:$wn,label:"wn — x"}]}],
    otherPlugins:[]
  }' > "$cat"
  jq -n '{
    deep:  {model:"claude-opus-4-8",effort:"xhigh",skillPlugins:{},otherPlugins:[],mcp:[]},
    plain: {model:"claude-opus-4-8",skillPlugins:{},otherPlugins:[],mcp:[]}
  }' > "$pf"

  printf '#!/bin/sh\nexit 1\n' > "$stub/gum"; chmod +x "$stub/gum"
  cat > "$stub/claude" <<EOF
#!/bin/zsh
print -r -- "\$*" > "$out/argv"
exit 0
EOF
  chmod +x "$stub/claude"

  ( PATH="$stub:$PATH"; CLX_CATALOG="$cat" CLX_PRESETS="$pf" clx deep >/dev/null 2>&1 )
  assert_eq "effort_passed" "$([[ "$(<"$out/argv")" == *"--effort xhigh"* ]] && echo yes)" "yes"

  ( PATH="$stub:$PATH"; CLX_CATALOG="$cat" CLX_PRESETS="$pf" clx plain >/dev/null 2>&1 )
  assert_eq "effort_omitted" "$([[ "$(<"$out/argv")" == *"--effort"* ]] && echo yes)" ""

  # Blank run picking an effort level, saved as preset p3.
  cat > "$stub/gum" <<EOF
#!/bin/zsh
emulate -L zsh
# Read piped choices like gum does; avoid producer SIGPIPE under pipefail.
[[ "\$1" == choose ]] && cat >/dev/null
local header="" selected="" cmd="\$1"
while (( \$# )); do case "\$1" in --header) header="\$2"; shift 2;; --selected) selected="\$2"; shift 2;; --placeholder) shift 2;; *) shift;; esac; done
case "\$cmd" in
  confirm) exit 0 ;;
  input)   print -r -- "p3"; exit 0 ;;
  choose)
    case "\$header" in
      "Preset:") print -r -- "— start blank —" ;;
      "Model:")  print -r -- "Opus 4.8" ;;
      "Effort:") print -r -- "high" ;;
      *) : ;;
    esac ;;
esac
exit 0
EOF
  chmod +x "$stub/gum"
  ( PATH="$stub:$PATH"; CLX_CATALOG="$cat" CLX_PRESETS="$pf" clx >/dev/null 2>&1 )
  assert_eq "effort_launch_flag" "$([[ "$(<"$out/argv")" == *"--effort high"* ]] && echo yes)" "yes"
  assert_eq "effort_saved"       "$(jq -r '.p3.effort' "$pf")" "high"

  rm -rf "$work" "$out" "$stub"
}

# Self-heal: a catalog whose skill dirs vanished (plugin version bump moved the
# cache path) must be regenerated via bootstrap before the menus run, and the
# session must proceed on the refreshed catalog.
() {
  local work=$(mktemp -d) out=$(mktemp -d) stub=$(mktemp -d)
  mkdir -p "$work/am2/skills/wn"   # the "new" skill location after the plugin update
  local cat="$work/loadout.json"
  jq -n '{
    models:[{id:"m-old",label:"M"}],
    mcpServers:{},
    skillPlugins:[{id:"workflow@example-skills",name:"am",skills:[{dir:"/nonexistent/am/skills/wn",label:"wn — x"}]}],
    otherPlugins:[]
  }' > "$cat"

  # Stub bootstrap: regenerates the catalog pointing at the new dir (and new model).
  cat > "$stub/bootstrap.zsh" <<EOF
#!/usr/bin/env zsh
: > "$out/bootstrap_ran"
jq -n --arg wn "$work/am2/skills/wn" '{
  models:[{id:"m-new",label:"M"}],
  mcpServers:{},
  skillPlugins:[{id:"workflow@example-skills",name:"am",skills:[{dir:\$wn,label:"wn — x"}]}],
  otherPlugins:[]
}' > "$work/loadout.json"
EOF

  # gum: echo back --selected (model menu); empty for everything else. confirm -> no.
  cat > "$stub/gum" <<'EOF'
#!/bin/zsh
emulate -L zsh
# Read piped choices like gum does; avoid producer SIGPIPE under pipefail.
[[ "$1" == choose ]] && cat >/dev/null
local cmd="$1" selected=""
while (( $# )); do case "$1" in --selected) selected="$2"; shift 2;; *) shift;; esac; done
[[ "$cmd" == confirm ]] && exit 1
[[ -n "$selected" ]] && print -r -- "$selected"
exit 0
EOF
  chmod +x "$stub/gum"
  cat > "$stub/claude" <<EOF
#!/bin/zsh
print -r -- "\$*" > "$out/argv"
exit 0
EOF
  chmod +x "$stub/claude"

  ( PATH="$stub:$PATH"; CLX_CATALOG="$cat" CLX_PRESETS="/nonexistent" \
      CLX_BOOTSTRAP="$stub/bootstrap.zsh" clx >/dev/null 2>&1 )
  assert_eq "heal_exit"          "$?" "0"
  assert_eq "heal_bootstrap_ran" "$([[ -f "$out/bootstrap_ran" ]] && echo yes)" "yes"
  assert_eq "heal_uses_new_catalog" \
    "$([[ "$(<"$out/argv")" == *"--model m-new"* ]] && echo yes)" "yes"
  rm -rf "$work" "$out" "$stub"
}

# Self-heal must NOT fire when all catalog dirs exist.
() {
  local work=$(mktemp -d) out=$(mktemp -d) stub=$(mktemp -d)
  mkdir -p "$work/am/skills/wn"
  local cat="$work/loadout.json"
  jq -n --arg wn "$work/am/skills/wn" '{
    models:[{id:"m",label:"M"}],
    mcpServers:{},
    skillPlugins:[{id:"workflow@example-skills",name:"am",skills:[{dir:$wn,label:"wn — x"}]}],
    otherPlugins:[]
  }' > "$cat"
  cat > "$stub/bootstrap.zsh" <<EOF
#!/usr/bin/env zsh
: > "$out/bootstrap_ran"
EOF
  cat > "$stub/gum" <<'EOF'
#!/bin/zsh
emulate -L zsh
# Read piped choices like gum does; avoid producer SIGPIPE under pipefail.
[[ "$1" == choose ]] && cat >/dev/null
local cmd="$1" selected=""
while (( $# )); do case "$1" in --selected) selected="$2"; shift 2;; *) shift;; esac; done
[[ "$cmd" == confirm ]] && exit 1
[[ -n "$selected" ]] && print -r -- "$selected"
exit 0
EOF
  chmod +x "$stub/gum"
  printf '#!/bin/sh\nexit 0\n' > "$stub/claude"; chmod +x "$stub/claude"

  ( PATH="$stub:$PATH"; CLX_CATALOG="$cat" CLX_PRESETS="/nonexistent" \
      CLX_BOOTSTRAP="$stub/bootstrap.zsh" clx >/dev/null 2>&1 )
  assert_eq "noheal_bootstrap_not_run" "$([[ -f "$out/bootstrap_ran" ]] && echo yes)" ""
  rm -rf "$work" "$out" "$stub"
}

# Regression: with NO preset, gum menus must receive their items via stdin only.
# A stray empty positional arg to `gum choose` makes real gum ignore stdin and
# show a single empty item (the bug from the presets change). The stub here flags
# any positional (non-flag) arg passed to choose.
() {
  local work=$(mktemp -d) out=$(mktemp -d) stub=$(mktemp -d)
  mkdir -p "$work/am/skills/wn"
  local cat="$work/loadout.json"
  jq -n --arg wn "$work/am/skills/wn" '{
    models:[{id:"m",label:"M"}],
    mcpServers:{srv:{command:"x",args:[],env:{}}},
    skillPlugins:[{id:"workflow@example-skills",name:"am",skills:[{dir:$wn,label:"wn — x"}]}],
    otherPlugins:[{id:"swift-lsp@x",name:"swift-lsp"}]
  }' > "$cat"
  cat > "$stub/gum" <<EOF
#!/bin/zsh
emulate -L zsh
# Read piped choices like gum does; avoid producer SIGPIPE under pipefail.
[[ "\$1" == choose ]] && cat >/dev/null
local cmd="\$1"; shift
local -a pos
while (( \$# )); do
  case "\$1" in
    --header|--selected) shift 2 ;;
    --*) shift ;;
    *) pos+=("\$1"); shift ;;
  esac
done
[[ "\$cmd" == choose && \${#pos[@]} -gt 0 ]] && printf 'POS:[%s]\n' "\${pos[@]}" >> "$out/badpos"
[[ "\$cmd" == choose ]] && head -1
exit 0
EOF
  chmod +x "$stub/gum"
  printf '#!/bin/sh\nexit 0\n' > "$stub/claude"; chmod +x "$stub/claude"
  ( PATH="$stub:$PATH"; CLX_CATALOG="$cat" CLX_PRESETS="/nonexistent" clx >/dev/null 2>&1 )
  assert_eq "int_no_positional_items" "$([[ -f "$out/badpos" ]] && cat "$out/badpos")" ""
  rm -rf "$work" "$out" "$stub"
}
