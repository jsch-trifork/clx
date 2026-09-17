local FIX="${0:A:h}/fixtures/loadout.json"
local PRE="${0:A:h}/fixtures/presets.json"

# Task 2 — _clx_model_default
assert_eq "model_default" "$(_clx_model_default "$FIX")" "claude-sonnet-4-6"

# Task 3 — _clx_mcp_config_json
assert_json_eq "mcp_one" \
  "$(_clx_mcp_config_json "$FIX" playwright)" \
  '{"mcpServers":{"playwright":{"command":"npx","args":["-y","playwright-mcp"],"env":{}}}}'

assert_json_eq "mcp_none" \
  "$(_clx_mcp_config_json "$FIX")" \
  '{"mcpServers":{}}'

assert_json_eq "mcp_two" \
  "$(_clx_mcp_config_json "$FIX" playwright context7)" \
  '{"mcpServers":{"playwright":{"command":"npx","args":["-y","playwright-mcp"],"env":{}},"context7":{"command":"npx","args":["-y","context7-mcp"],"env":{}}}}'

# Task 4 — _clx_enabled_plugins_json
assert_json_eq "enabled_full_am" \
  "$(_clx_enabled_plugins_json "$FIX" 'workflow@example-skills')" \
  '{"enabledPlugins":{"workflow@example-skills":true,"superpowers@claude-plugins-official":false,"swift-lsp@claude-plugins-official":false}}'

assert_json_eq "enabled_none" \
  "$(_clx_enabled_plugins_json "$FIX")" \
  '{"enabledPlugins":{"workflow@example-skills":false,"superpowers@claude-plugins-official":false,"swift-lsp@claude-plugins-official":false}}'

assert_json_eq "enabled_other" \
  "$(_clx_enabled_plugins_json "$FIX" 'swift-lsp@claude-plugins-official')" \
  '{"enabledPlugins":{"workflow@example-skills":false,"superpowers@claude-plugins-official":false,"swift-lsp@claude-plugins-official":true}}'

# Task — _clx_plugin_mode
assert_eq "mode_full"   "$(_clx_plugin_mode '(all am)' '(all am)' 'work-next — x')" "full"
assert_eq "mode_subset" "$(_clx_plugin_mode '(all am)' 'work-next — x')"            "subset"
assert_eq "mode_off"    "$(_clx_plugin_mode '(all am)')"                            "off"
assert_eq "mode_off_empty" "$(_clx_plugin_mode '(all am)' '')"                      "off"

# Task — _clx_skill_dirs_for_labels
assert_eq "dirs_one" \
  "$(_clx_skill_dirs_for_labels "$FIX" 'workflow@example-skills' 'work-next — Navigate the plan')" \
  "/fix/am/skills/work-next"

assert_eq "dirs_two" \
  "$(_clx_skill_dirs_for_labels "$FIX" 'workflow@example-skills' 'work-next — Navigate the plan' 'work-plan — Generate a plan' | tr '\n' ',')" \
  "/fix/am/skills/work-next,/fix/am/skills/work-plan,"

assert_eq "dirs_skip_empty" \
  "$(_clx_skill_dirs_for_labels "$FIX" 'workflow@example-skills' '')" \
  ""

# Task — _clx_build_synth_plugin
() {
  local dest=$(mktemp -d) sk=$(mktemp -d) out base
  out=$(_clx_build_synth_plugin "$dest" am "$sk")
  base=${sk:t}
  assert_eq "synth_path"     "$out"                                              "$dest/am"
  assert_eq "synth_manifest" "$([[ -f "$dest/am/.claude-plugin/plugin.json" ]] && echo yes)" "yes"
  assert_eq "synth_name"     "$(jq -r .name "$dest/am/.claude-plugin/plugin.json")"          "am"
  assert_eq "synth_symlink"  "$([[ -L "$dest/am/skills/$base" ]] && echo yes)"   "yes"
  assert_eq "synth_target"   "$(readlink "$dest/am/skills/$base")"               "$sk"
  rm -rf "$dest" "$sk"
}

# Task — _clx_match_preset (direct invocation)
assert_eq "match_exact"      "$(_clx_match_preset "$PRE" web)"        "web"
assert_eq "match_ci"         "$(_clx_match_preset "$PRE" WEB)"        "web"
assert_eq "match_prefix"     "$(_clx_match_preset "$PRE" st)"         "stale"
assert_eq "match_substring"  "$(_clx_match_preset "$PRE" tal)"        "stale"
assert_eq "match_none"       "$(_clx_match_preset "$PRE" nosuch)"     ""
assert_eq "match_missing_file" "$(_clx_match_preset /nonexistent web)" ""
# Ambiguity: 'e' is a ci-substring of both presets -> two lines.
assert_eq "match_ambiguous_count" "$(_clx_match_preset "$PRE" e | wc -l | tr -d ' ')" "2"

# Task — _clx_preset_effort
assert_eq "effort_unset" "$(_clx_preset_effort "$PRE" web)" ""
() {
  local pf=$(mktemp)
  jq -n '{deep:{model:"claude-opus-4-8",effort:"xhigh"}}' > "$pf"
  assert_eq "effort_set" "$(_clx_preset_effort "$pf" deep)" "xhigh"
  rm -f "$pf"
}

# Task — _clx_preset_display (model + effort shown in preset menu)
assert_eq "display_label" \
  "$(_clx_preset_display "$PRE" "$FIX" web)" \
  "web  ·  Opus 4.8"
() {
  # Model id not in catalog -> fall back to the raw id; no model -> bare name;
  # effort appended when set.
  local pf=$(mktemp)
  jq -n '{ghost:{model:"claude-x"},bare:{skillPlugins:{}},deep:{model:"claude-opus-4-8",effort:"xhigh"}}' > "$pf"
  assert_eq "display_fallback_id" "$(_clx_preset_display "$pf" "$FIX" ghost)" "ghost  ·  claude-x"
  assert_eq "display_no_model"    "$(_clx_preset_display "$pf" "$FIX" bare)"  "bare"
  assert_eq "display_effort"      "$(_clx_preset_display "$pf" "$FIX" deep)"  "deep  ·  Opus 4.8  ·  xhigh"
  rm -f "$pf"
}

# Task — _clx_catalog_missing_dirs (self-heal staleness check)
# Fixture dirs (/fix/...) don't exist on disk, so all of them are reported.
assert_eq "stale_first_missing" \
  "$(_clx_catalog_missing_dirs "$FIX" | head -1)" \
  "/fix/am/skills/work-next"
() {
  local d=$(mktemp -d) c=$(mktemp)
  jq -n --arg d "$d" '{skillPlugins:[{id:"x",name:"x",skills:[{dir:$d,label:"a — b"}]}]}' > "$c"
  assert_eq "stale_none_missing" "$(_clx_catalog_missing_dirs "$c")" ""
  rm -rf "$d" "$c"
}

# Task 5 — _clx_preflight
_clx_preflight "/nonexistent/loadout.json" 2>/dev/null
assert_eq "preflight_missing_catalog" "$?" "1"

# preflight_ok: stub deps on PATH so the test is independent of host tooling.
local _stub_dir=$(mktemp -d)
local _t
for _t in gum claude; do
  print -r -- '#!/bin/sh' > "$_stub_dir/$_t"
  chmod +x "$_stub_dir/$_t"
done
( PATH="$_stub_dir:$PATH"; _clx_preflight "$FIX" >/dev/null 2>&1 )
assert_eq "preflight_ok" "$?" "0"
rm -rf "$_stub_dir"
unset _stub_dir _t

() {
  local old=$(mktemp) stub=$(mktemp -d) t
  echo '{"models":[],"mcpServers":{}}' > "$old"
  for t in gum claude; do print -r -- '#!/bin/sh' > "$stub/$t"; chmod +x "$stub/$t"; done
  ( PATH="$stub:$PATH"; _clx_preflight "$old" >/dev/null 2>&1 )
  assert_eq "preflight_old_shape" "$?" "1"
  rm -rf "$old" "$stub"
}

# Task 2 — preset getters
assert_eq "pnames"        "$(_clx_preset_names "$PRE" | tr '\n' ',')"            "stale,web,"
assert_eq "pnames_missing" "$(_clx_preset_names /nope/presets.json)"            ""
assert_eq "pmodel"        "$(_clx_preset_model "$PRE" web)"                      "claude-opus-4-8"
assert_eq "pmode_full"    "$(_clx_preset_plugin_mode "$PRE" web 'superpowers@claude-plugins-official')" "full"
assert_eq "pmode_subset"  "$(_clx_preset_plugin_mode "$PRE" web 'workflow@example-skills')"                     "subset"
assert_eq "pmode_off"     "$(_clx_preset_plugin_mode "$PRE" web 'swift-lsp@claude-plugins-official')"   "off"
assert_eq "pmcp"          "$(_clx_preset_mcp "$PRE" web)"                        "context7"

# Task 3 — catalog-aware resolvers
assert_eq "psub_web_am" \
  "$(_clx_preset_subset_dirs "$FIX" "$PRE" web 'workflow@example-skills')" \
  "/fix/am/skills/work-next"
assert_eq "psub_stale_am" \
  "$(_clx_preset_subset_dirs "$FIX" "$PRE" stale 'workflow@example-skills')" \
  "/fix/am/skills/work-next"
assert_eq "ppre_full_sp" \
  "$(_clx_preset_preselect_labels "$FIX" "$PRE" web 'superpowers@claude-plugins-official')" \
  "(all superpowers)"
assert_eq "ppre_subset_am" \
  "$(_clx_preset_preselect_labels "$FIX" "$PRE" web 'workflow@example-skills')" \
  "work-next — Navigate the plan"
assert_eq "ppre_off_swift" \
  "$(_clx_preset_preselect_labels "$FIX" "$PRE" web 'swift-lsp@claude-plugins-official')" \
  ""
assert_eq "pother_ids"   "$(_clx_preset_other_ids "$FIX" "$PRE" web)"   "swift-lsp@claude-plugins-official"
assert_eq "pother_names" "$(_clx_preset_other_names "$FIX" "$PRE" web)" "swift-lsp"

# Task 4 — save & delete preset
() {
  local f=$(mktemp); rm -f "$f"
  _clx_save_preset "$f" foo '{"model":"m1","skillPlugins":{},"otherPlugins":[],"mcp":[]}'
  assert_json_eq "save_new" "$(cat "$f")" '{"foo":{"model":"m1","skillPlugins":{},"otherPlugins":[],"mcp":[]}}'
  _clx_save_preset "$f" bar '{"model":"m2","skillPlugins":{},"otherPlugins":[],"mcp":[]}'
  assert_eq "save_add_keys" "$(jq -r 'keys|join(",")' "$f")" "bar,foo"
  _clx_save_preset "$f" foo '{"model":"m9","skillPlugins":{},"otherPlugins":[],"mcp":[]}'
  assert_eq "save_overwrite" "$(jq -r '.foo.model' "$f")" "m9"
  _clx_delete_preset "$f" bar
  assert_eq "delete_one" "$(jq -r 'keys|join(",")' "$f")" "foo"
  _clx_delete_preset "$f" foo
  assert_json_eq "delete_last" "$(cat "$f")" '{}'
  rm -f "$f"
}

# Task 5 — _clx_selected_args
assert_eq "selargs_two"   "$(_clx_selected_args a 'b c' | tr '\n' '|')" "--selected|a|--selected|b c|"
assert_eq "selargs_skip"  "$(_clx_selected_args '' x | tr '\n' '|')"    "--selected|x|"
assert_eq "selargs_empty" "$(_clx_selected_args)"                       ""
