# prompts: a preset names a prompt, clx resolves it from prompts/<name>.md and
# appends it to the session. Covers resolution, the none case, the missing-file
# fallback, and the customize menu writing a name (not the text) back.

# --- resolution helpers ---
() {
  local dir=$(mktemp -d)
  print -r -- "First line here.\nSecond line." > "$dir/alpha.md"
  print -r -- "Beta prompt." > "$dir/beta.md"
  print -r -- "not a prompt" > "$dir/gamma.txt"

  assert_eq "prompt_names" "$(_clx_prompt_names "$dir" | sort | tr '\n' ' ')" "alpha beta "
  assert_eq "prompt_text_by_name" "$(_clx_prompt_text "$dir" beta)" "Beta prompt."
  assert_eq "prompt_text_empty"   "$(_clx_prompt_text "$dir" "")"   ""
  # A value that names no file is literal text, so an inline prompt still works.
  assert_eq "prompt_text_literal" "$(_clx_prompt_text "$dir" "inline words")" "inline words"
  assert_eq "prompt_display"      "$(_clx_prompt_display "$dir" beta)" "beta  ·  Beta prompt."
  # A name whose file has gone missing degrades to the bare name, not an error.
  assert_eq "prompt_display_missing" "$(_clx_prompt_display "$dir" nosuch)" "nosuch  ·  "
  assert_eq "prompt_names_empty_dir" "$(_clx_prompt_names "$dir/nope" | wc -l | tr -d ' ')" "0"
  # A deleted prompt must not leak its own name into the system prompt.
  assert_eq "prompt_text_missing_name" "$(_clx_prompt_text "$dir" deleted-one 2>/dev/null)" ""
  assert_eq "prompt_text_missing_warns" \
    "$(_clx_prompt_text "$dir" deleted-one 2>&1 >/dev/null | grep -c "not found")" "1"
  rm -rf "$dir"
}

# --- as-is: a preset naming a prompt appends that file's text ---
() {
  local work=$(mktemp -d) out=$(mktemp -d) stub=$(mktemp -d) pdir=$(mktemp -d)
  mkdir -p "$work/am/skills/work-next"
  local cat="$work/loadout.json" pf="$work/presets.json"
  jq -n --arg d "$work/am/skills/work-next" '{
    models:[{id:"claude-sonnet-4-6",label:"Sonnet 4.6 (fast; default)"}],
    mcpServers:{}, otherPlugins:[],
    skillPlugins:[{id:"workflow@example-skills",name:"am",skills:[{dir:$d,label:"work-next — nav"}]}]
  }' > "$cat"
  jq -n '{withp:{model:"claude-sonnet-4-6",skillPlugins:{},otherPlugins:[],mcp:[],prompt:"pv"},
          nop:{model:"claude-sonnet-4-6",skillPlugins:{},otherPlugins:[],mcp:[]}}' > "$pf"
  print -r -- "Always show two directions." > "$pdir/pv.md"

  cat > "$stub/claude" <<EOF
#!/bin/zsh
emulate -L zsh
print -r -- "\$*" > "$out/argv"
local i=1; while (( i <= \$# )); do
  case "\${@[i]}" in --append-system-prompt-file) cp "\${@[i+1]}" "$out/prompt.txt";; esac
  (( i++ ))
done
exit 0
EOF
  chmod +x "$stub/claude"

  cat > "$stub/gum" <<'EOF'
#!/bin/zsh
emulate -L zsh
# Read piped choices like gum does; avoid producer SIGPIPE under pipefail.
[[ "$1" == choose ]] && cat >/dev/null
local header=""
while (( $# )); do case "$1" in --header) header="$2"; shift 2;; --selected) shift 2;; *) shift;; esac; done
case "$header" in
  "Preset:")   print -r -- "PRESET_NAME" ;;
  "Preset '"*) print -r -- "use as-is" ;;
esac
exit 0
EOF
  sed -i.bak "s/PRESET_NAME/withp/" "$stub/gum"; chmod +x "$stub/gum"
  ( PATH="$stub:$PATH"; CLX_CATALOG="$cat" CLX_PRESETS="$pf" CLX_PROMPTS_DIR="$pdir" clx >/dev/null 2>&1 )
  assert_eq "prompt_flag_passed" \
    "$([[ "$(<"$out/argv")" == *"--append-system-prompt-file"* ]] && echo yes)" "yes"
  assert_eq "prompt_file_content" "$(<"$out/prompt.txt")" "Always show two directions."
  assert_eq "prompt_status_not_an_arg" "$([[ "$(<"$out/argv")" == *"prompt=yes"* ]] && echo yes || echo no)" "no"

  # A preset with no prompt must not pass the flag at all.
  rm -f "$out/argv" "$out/prompt.txt"
  sed -i.bak "s/withp/nop/" "$stub/gum"
  ( PATH="$stub:$PATH"; CLX_CATALOG="$cat" CLX_PRESETS="$pf" CLX_PROMPTS_DIR="$pdir" clx >/dev/null 2>&1 )
  assert_eq "prompt_absent_no_flag" \
    "$([[ "$(<"$out/argv")" == *"--append-system-prompt-file"* ]] && echo yes || echo no)" "no"

  rm -rf "$work" "$out" "$stub" "$pdir"
}

# --- customize: the Prompt menu stores the NAME, and none clears it ---
() {
  local work=$(mktemp -d) out=$(mktemp -d) stub=$(mktemp -d) pdir=$(mktemp -d)
  mkdir -p "$work/am/skills/work-next"
  local cat="$work/loadout.json" pf="$work/presets.json"
  jq -n --arg d "$work/am/skills/work-next" '{
    models:[{id:"claude-sonnet-4-6",label:"Sonnet 4.6 (fast; default)"}],
    mcpServers:{}, otherPlugins:[],
    skillPlugins:[{id:"workflow@example-skills",name:"am",skills:[{dir:$d,label:"work-next — nav"}]}]
  }' > "$cat"
  jq -n '{p1:{model:"claude-sonnet-4-6",skillPlugins:{},otherPlugins:[],mcp:[]}}' > "$pf"
  print -r -- "Always show two directions." > "$pdir/pv.md"

  printf '#!/bin/zsh\nexit 0\n' > "$stub/claude"; chmod +x "$stub/claude"
  cat > "$stub/gum" <<'EOF'
#!/bin/zsh
emulate -L zsh
# Read piped choices like gum does; avoid producer SIGPIPE under pipefail.
[[ "$1" == choose ]] && cat >/dev/null
local header="" cmd="$1"
while (( $# )); do case "$1" in --header) header="$2"; shift 2;; --selected) shift 2;; --placeholder) shift 2;; *) shift;; esac; done
case "$cmd" in
  confirm) exit 1 ;;
  input)   exit 1 ;;
  choose)
    case "$header" in
      "Preset:")       print -r -- "p1" ;;
      "Preset '"*)     print -r -- "customize" ;;
      "Model:")        print -r -- "Sonnet 4.6 (fast; default)" ;;
      "Effort:")       print -r -- "(default)" ;;
      "Prompt:")       print -r -- "pv  ·  Always show two directions." ;;
      "am —"*)         print -r -- "(all am)" ;;
      "MCP servers"*)  : ;;
      "Save changes?") print -r -- "Update 'p1'" ;;
    esac ;;
esac
exit 0
EOF
  chmod +x "$stub/gum"
  ( PATH="$stub:$PATH"; CLX_CATALOG="$cat" CLX_PRESETS="$pf" CLX_PROMPTS_DIR="$pdir" clx >/dev/null 2>&1 )
  # The preset stores the name, never the prompt body.
  assert_eq "prompt_saved_name" "$(jq -r '.p1.prompt' "$pf")" "pv"

  # Choosing "— none —" removes it again.
  sed -i.bak 's/print -r -- "pv  ·  Always show two directions."/print -r -- "— none —"/' "$stub/gum"
  ( PATH="$stub:$PATH"; CLX_CATALOG="$cat" CLX_PRESETS="$pf" CLX_PROMPTS_DIR="$pdir" clx >/dev/null 2>&1 )
  assert_eq "prompt_cleared" "$(jq -r '.p1.prompt // "none"' "$pf")" "none"

  rm -rf "$work" "$out" "$stub" "$pdir"
}

# --- reference bookkeeping ---
() {
  local pf=$(mktemp)
  jq -n '{A:{prompt:"pv"},B:{prompt:"other"},C:{}}' > "$pf"
  assert_eq "prompt_users_one"  "$(_clx_prompt_users "$pf" pv)"    "A"
  assert_eq "prompt_users_none" "$(_clx_prompt_users "$pf" nobody)" ""
  jq -n '{A:{prompt:"pv"},B:{prompt:"pv"},C:{}}' > "$pf"
  assert_eq "prompt_users_many" "$(_clx_prompt_users "$pf" pv)" "A, B"

  _clx_prompt_repoint "$pf" pv renamed
  assert_eq "prompt_repoint_renames" "$(jq -r '.A.prompt' "$pf")" "renamed"
  _clx_prompt_repoint "$pf" renamed ""
  assert_eq "prompt_repoint_removes"   "$(jq -r '.A.prompt // "gone"' "$pf")" "gone"
  assert_eq "prompt_repoint_keeps_rest" "$(jq -r '.C | has("prompt")' "$pf")" "false"
  rm -f "$pf"
}

# --- `clx prompts`: new, rename, delete, each keeping presets in step ---
() {
  local pdir=$(mktemp -d) stub=$(mktemp -d) pf=$(mktemp) q=$(mktemp)

  # gum stub: pops one scripted answer per call. __OK__/__NO__ are confirm results.
  cat > "$stub/gum" <<'EOF'
#!/bin/zsh
emulate -L zsh
# Read piped choices like gum does; avoid producer SIGPIPE under pipefail.
[[ "$1" == choose ]] && cat >/dev/null
local resp
resp=$(head -1 "$CLX_TEST_QUEUE")
sed -i.bak '1d' "$CLX_TEST_QUEUE"
case "$resp" in
  __OK__) exit 0 ;;
  __NO__) exit 1 ;;
  __CANCEL__) exit 1 ;;
  *) print -r -- "$resp"; exit 0 ;;
esac
EOF
  chmod +x "$stub/gum"
  # editor stub: writes a line into whatever file it is handed
  printf '#!/bin/zsh\nprint -r -- "Editor wrote this." > "$1"\n' > "$stub/ed"; chmod +x "$stub/ed"

  jq -n '{Design:{model:"m",prompt:"pv"}}' > "$pf"
  print -r -- "Existing prompt body." > "$pdir/pv.md"

  # 1. create a new prompt
  print -rl -- "+ new prompt" "greeting" "— done —" > "$q"
  ( PATH="$stub:$PATH"; CLX_TEST_QUEUE="$q" EDITOR="$stub/ed" \
      CLX_PROMPTS_DIR="$pdir" CLX_PRESETS="$pf" clx prompts >/dev/null 2>&1 )
  assert_eq "prompts_new_created" "$([[ -f "$pdir/greeting.md" ]] && echo yes)" "yes"
  assert_eq "prompts_new_content" "$(<"$pdir/greeting.md")" "Editor wrote this."

  # 2. an editor that writes nothing leaves no empty file behind
  printf '#!/bin/zsh\nexit 0\n' > "$stub/noop"; chmod +x "$stub/noop"
  print -rl -- "+ new prompt" "ghost" "— done —" > "$q"
  ( PATH="$stub:$PATH"; CLX_TEST_QUEUE="$q" EDITOR="$stub/noop" \
      CLX_PROMPTS_DIR="$pdir" CLX_PRESETS="$pf" clx prompts >/dev/null 2>&1 )
  assert_eq "prompts_new_empty_discarded" "$([[ -e "$pdir/ghost.md" ]] && echo yes || echo no)" "no"

  # 3. rename repoints the preset that used it
  print -rl -- "pv  ·  Existing prompt body.   (used by: Design)" "rename" "pv-renamed" "— done —" > "$q"
  ( PATH="$stub:$PATH"; CLX_TEST_QUEUE="$q" EDITOR="$stub/ed" \
      CLX_PROMPTS_DIR="$pdir" CLX_PRESETS="$pf" clx prompts >/dev/null 2>&1 )
  assert_eq "prompts_renamed_file"   "$([[ -f "$pdir/pv-renamed.md" && ! -e "$pdir/pv.md" ]] && echo yes)" "yes"
  assert_eq "prompts_renamed_preset" "$(jq -r '.Design.prompt' "$pf")" "pv-renamed"

  # 4. delete clears the reference too, so no preset is left dangling
  print -rl -- "pv-renamed  ·  Existing prompt body.   (used by: Design)" "delete" "__OK__" "— done —" > "$q"
  ( PATH="$stub:$PATH"; CLX_TEST_QUEUE="$q" EDITOR="$stub/ed" \
      CLX_PROMPTS_DIR="$pdir" CLX_PRESETS="$pf" clx prompts >/dev/null 2>&1 )
  assert_eq "prompts_deleted_file"      "$([[ -e "$pdir/pv-renamed.md" ]] && echo yes || echo no)" "no"
  assert_eq "prompts_deleted_reference" "$(jq -r '.Design.prompt // "gone"' "$pf")" "gone"

  # 5. declining the confirm keeps the file
  print -rl -- "greeting  ·  Editor wrote this.   (unused)" "delete" "__NO__" "— done —" > "$q"
  ( PATH="$stub:$PATH"; CLX_TEST_QUEUE="$q" EDITOR="$stub/ed" \
      CLX_PROMPTS_DIR="$pdir" CLX_PRESETS="$pf" clx prompts >/dev/null 2>&1 )
  assert_eq "prompts_delete_declined" "$([[ -f "$pdir/greeting.md" ]] && echo yes)" "yes"

  rm -rf "$pdir" "$stub" "$pf" "$q"
}
