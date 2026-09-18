# clx — interactive Claude Code launcher. Source from ~/.zshrc.
typeset -g _CLX_SOURCE_DIR="${${(%):-%x}:A:h}"

_clx_model_default() { jq -r '.models[0].id' "$1"; }

_clx_mcp_config_json() {
  local catalog="$1"; shift
  local sel='[]'
  (( $# )) && sel=$(printf '%s\n' "$@" | jq -R . | jq -s .)
  jq --argjson sel "$sel" \
    '{mcpServers: (.mcpServers | to_entries
        | map(select([.key] | inside($sel)))
        | from_entries)}' "$catalog"
}

_clx_enabled_plugins_json() {
  local catalog="$1"; shift
  local sel='[]'
  (( $# )) && sel=$(printf '%s\n' "$@" | jq -R . | jq -s .)
  jq --argjson sel "$sel" \
    '{enabledPlugins: ([.skillPlugins[].id] + [.otherPlugins[].id] | unique
       | map(. as $id | {($id): (($sel | map(select(. == $id)) | length) > 0)}) | add // {})}' "$catalog"
}

_clx_build_synth_plugin() {
  local destroot="$1" name="$2"; shift 2
  local pdir="$destroot/$name"
  mkdir -p "$pdir/.claude-plugin"
  # Mirror each skill at the path its ORIGIN plugin used. Flattening everything
  # into skills/ breaks any SKILL.md that resolves its own scripts through
  # ${CLAUDE_PLUGIN_ROOT} -- ui-ux-pro-max ships under .claude/skills/ and its
  # search.py silently disappears when the layout is not preserved.
  local d rel
  typeset -A rels
  for d in "$@"; do
    [[ -z "$d" ]] && continue
    if [[ "$d" == */.claude/skills/* ]]; then rel=".claude/skills"; else rel="skills"; fi
    mkdir -p "$pdir/$rel"
    ln -s "$d" "$pdir/$rel/${d:t}"
    rels[$rel]=1
  done
  (( ${#rels[@]} )) || { mkdir -p "$pdir/skills"; rels[skills]=1 }
  local -a roots
  for rel in ${(k)rels}; do roots+=("./$rel/"); done
  jq -n --arg n "$name" --argjson s "$(printf '%s\n' "${roots[@]}" | jq -R . | jq -s .)" \
    '{name:$n, description:"clx session subset", version:"0.0.0", skills:$s}' \
    > "$pdir/.claude-plugin/plugin.json"
  print -r -- "$pdir"
}

_clx_skill_dirs_for_labels() {
  local catalog="$1" pid="$2"; shift 2
  local l
  for l in "$@"; do
    [[ -z "$l" ]] && continue
    jq -r --arg p "$pid" --arg l "$l" \
      '.skillPlugins[] | select(.id==$p) | .skills[] | select(.label==$l) | .dir' "$catalog"
  done
}

_clx_plugin_mode() {
  local sentinel="$1"; shift
  local has=0 l
  for l in "$@"; do
    [[ -z "$l" ]] && continue
    [[ "$l" == "$sentinel" ]] && { print -r -- full; return; }
    has=1
  done
  (( has )) && print -r -- subset || print -r -- off
}

_clx_preset_names() { [[ -f "$1" ]] || return 0; jq -r 'keys[]' "$1" 2>/dev/null; }
_clx_preset_model() { jq -r --arg n "$2" '.[$n].model // empty' "$1"; }
_clx_preset_effort() { jq -r --arg n "$2" '.[$n].effort // empty' "$1"; }
_clx_preset_plugin_mode() { jq -r --arg n "$2" --arg p "$3" '.[$n].skillPlugins[$p].mode // "off"' "$1"; }
_clx_preset_mcp() { jq -r --arg n "$2" '.[$n].mcp // [] | .[]' "$1"; }
# Optional per-preset system-prompt addendum, appended to the session's default.
_clx_preset_prompt() { jq -r --arg n "$2" '.[$n].prompt // empty' "$1"; }

# Prompt library: one .md per prompt under prompts/, referenced by name from a
# preset. Keeping the text in files rather than inline in presets.json means a
# prompt can be shared between presets, edited in an editor, and versioned --
# User preset and prompt files stay outside the distributed source.
_clx_prompt_names() {
  local dir="$1" f
  [[ -d "$dir" ]] || return 0
  for f in "$dir"/*.md(N); do print -r -- "${${f:t}%.md}"; done
}
_clx_prompt_text() {
  # A value naming a file wins. A multi-word value is legacy inline prompt text
  # and is used as-is. A bare name with no file behind it means the prompt was
  # deleted or renamed -- say so, rather than silently appending the name itself
  # to the system prompt.
  local dir="$1" val="$2"
  [[ -z "$val" ]] && return 0
  if [[ -f "$dir/$val.md" ]]; then
    cat "$dir/$val.md"
  elif [[ "$val" == *[[:space:]]* ]]; then
    print -r -- "$val"
  else
    print -ru2 -- "clx: prompt '$val' not found in $dir — launching without it"
    return 0
  fi
}
# Presets referencing a prompt, comma-joined. Delete and rename consult this so
# a preset is never left naming a prompt that no longer exists.
_clx_prompt_users() {
  [[ -f "$1" ]] || return 0
  jq -r --arg p "$2" '[to_entries[] | select(.value.prompt == $p) | .key] | join(", ")' "$1"
}
# Repoint every reference from $2 to $3; an empty $3 removes the field.
_clx_prompt_repoint() {
  local file="$1" from="$2" to="$3" tmp
  [[ -f "$file" ]] || return 0
  tmp=$(mktemp "${TMPDIR:-/tmp}/clx-presets-XXXXXX") || return 1
  if [[ -z "$to" ]]; then
    jq --arg f "$from" 'map_values(if .prompt == $f then del(.prompt) else . end)' "$file" > "$tmp"
  else
    jq --arg f "$from" --arg t "$to" 'map_values(if .prompt == $f then .prompt = $t else . end)' "$file" > "$tmp"
  fi
  mv "$tmp" "$file"
}

_clx_prompt_display() {
  local dir="$1" name="$2" first=""
  [[ -f "$dir/$name.md" ]] && first=$(awk 'NF {print; exit}' "$dir/$name.md")
  print -r -- "$name  ·  ${first[1,70]}"
}

_clx_preset_subset_dirs() {
  local catalog="$1" file="$2" name="$3" pid="$4" base
  jq -r --arg n "$name" --arg p "$pid" '.[$n].skillPlugins[$p].skills // [] | .[]' "$file" | while IFS= read -r base; do
    [[ -z "$base" ]] && continue
    jq -r --arg p "$pid" --arg b "$base" \
      '.skillPlugins[] | select(.id==$p) | .skills[] | select((.dir|split("/")|last)==$b) | .dir' "$catalog"
  done
}
_clx_preset_preselect_labels() {
  local catalog="$1" file="$2" name="$3" pid="$4" mode pname base
  mode=$(_clx_preset_plugin_mode "$file" "$name" "$pid")
  case "$mode" in
    full)
      pname=$(jq -r --arg p "$pid" '.skillPlugins[] | select(.id==$p) | .name' "$catalog")
      print -r -- "(all $pname)" ;;
    subset)
      jq -r --arg n "$name" --arg p "$pid" '.[$n].skillPlugins[$p].skills // [] | .[]' "$file" | while IFS= read -r base; do
        [[ -z "$base" ]] && continue
        jq -r --arg p "$pid" --arg b "$base" \
          '.skillPlugins[] | select(.id==$p) | .skills[] | select((.dir|split("/")|last)==$b) | .label' "$catalog"
      done ;;
    *) : ;;
  esac
}
_clx_preset_other_ids() {
  local catalog="$1" file="$2" name="$3" id
  jq -r --arg n "$name" '.[$n].otherPlugins // [] | .[]' "$file" | while IFS= read -r id; do
    [[ -z "$id" ]] && continue
    jq -e --arg id "$id" '.otherPlugins[] | select(.id==$id)' "$catalog" >/dev/null 2>&1 && print -r -- "$id"
  done
}
_clx_preset_other_names() {
  local catalog="$1" file="$2" name="$3" id
  _clx_preset_other_ids "$catalog" "$file" "$name" | while IFS= read -r id; do
    [[ -z "$id" ]] && continue
    jq -r --arg id "$id" '.otherPlugins[] | select(.id==$id) | .name' "$catalog"
  done
}

_clx_match_preset() {
  # Print candidate preset names for a query: exact match wins, then
  # case-insensitive exact, then ci-prefix, then ci-substring.
  local file="$1" q="$2" n
  local ql="${(L)q}"
  local -a names exact ciexact prefix sub
  names=("${(@f)$(_clx_preset_names "$file")}"); names=("${(@)names:#}")
  for n in "${names[@]}"; do
    [[ "$n" == "$q" ]] && exact+=("$n")
    [[ "${(L)n}" == "$ql" ]] && ciexact+=("$n")
    [[ "${(L)n}" == "$ql"* ]] && prefix+=("$n")
    [[ "${(L)n}" == *"$ql"* ]] && sub+=("$n")
  done
  if (( ${#exact[@]} )); then print -rl -- "${exact[@]}"
  elif (( ${#ciexact[@]} )); then print -rl -- "${ciexact[@]}"
  elif (( ${#prefix[@]} )); then print -rl -- "${prefix[@]}"
  elif (( ${#sub[@]} )); then print -rl -- "${sub[@]}"
  fi
  return 0
}

_clx_preset_display() {
  # "name  ·  <model label>[  ·  <effort>]" for the preset menu; falls back to
  # the raw model id, or the bare name when the preset has no model.
  local file="$1" catalog="$2" name="$3" mid mlabel eff out
  mid=$(_clx_preset_model "$file" "$name")
  eff=$(_clx_preset_effort "$file" "$name")
  if [[ -z "$mid" ]]; then
    out="$name"
  else
    mlabel=$(jq -r --arg id "$mid" '.models[] | select(.id==$id) | .label' "$catalog" 2>/dev/null)
    [[ -z "$mlabel" ]] && mlabel="$mid"
    out="$name  ·  $mlabel"
  fi
  [[ -n "$eff" && -n "$mid" ]] && out+="  ·  $eff"
  print -r -- "$out"
}

_clx_save_preset() {
  local file="$1" name="$2" obj="$3" base='{}'
  [[ -f "$file" ]] && base=$(cat "$file")
  jq --arg n "$name" --argjson o "$obj" '.[$n]=$o' <<<"$base" > "$file"
}
_clx_delete_preset() {
  local file="$1" name="$2"
  [[ -f "$file" ]] || return 0
  local tmp="$file.tmp"
  jq --arg n "$name" 'del(.[$n])' "$file" > "$tmp" && mv "$tmp" "$file"
}

_clx_selected_args() {
  local v
  for v in "$@"; do
    [[ -z "$v" ]] && continue
    print -r -- "--selected"
    print -r -- "$v"
  done
}

_clx_catalog_missing_dirs() {
  jq -r '.skillPlugins[].skills[].dir' "$1" 2>/dev/null | while IFS= read -r d; do
    [[ -n "$d" && ! -d "$d" ]] && print -r -- "$d"
  done
  return 0
}

_clx_preflight() {
  local catalog="$1" c
  local -a missing
  for c in gum jq "${CLX_CLAUDE_BIN:-claude}"; do command -v "$c" >/dev/null 2>&1 || missing+=("$c"); done
  if (( ${#missing[@]} )); then
    print -ru2 -- "clx: missing dependencies: ${missing[*]}  (e.g. brew install gum jq)"
    return 1
  fi
  if [[ ! -f "$catalog" ]]; then
    print -ru2 -- "clx: no catalog at '$catalog'. Run: clx init"
    return 1
  fi
  if ! jq -e 'has("skillPlugins")' "$catalog" >/dev/null 2>&1; then
    print -ru2 -- "clx: catalog '$catalog' is an old format. Re-run: clx init --force"
    return 1
  fi
  return 0
}

# `clx prompts` — manage the prompt library: new, edit, rename, delete. Deleting
# or renaming also fixes up every preset that referenced it, so the library and
# presets.json cannot drift apart.
_clx_prompts_manage() {
  local dir="$1" presets_file="$2"
  mkdir -p "$dir" || return 1
  local editor="${VISUAL:-${EDITOR:-vi}}"
  local -a names display
  local n choice action target users label newname
  while true; do
    names=("${(@f)$(_clx_prompt_names "$dir")}"); names=("${(@)names:#}")
    display=("+ new prompt")
    for n in "${names[@]}"; do
      users=$(_clx_prompt_users "$presets_file" "$n")
      [[ -n "$users" ]] && label="used by: $users" || label="unused"
      display+=("$(_clx_prompt_display "$dir" "$n")   ($label)")
    done
    choice=$(print -rl -- "${display[@]}" "— done —" | gum choose --header "Prompts:") || return 0
    case "$choice" in
      "— done —") return 0 ;;
      "+ new prompt")
        newname=$(gum input --placeholder "prompt name, e.g. terse-output") || continue
        newname="${${newname## }%% }"; newname="${newname// /-}"
        [[ -z "$newname" ]] && continue
        if [[ -f "$dir/$newname.md" ]]; then
          print -ru2 -- "clx: '$newname' already exists"; continue
        fi
        : > "$dir/$newname.md"
        "$editor" "$dir/$newname.md"
        # An untouched file is not a prompt; do not leave an empty one behind.
        if [[ ! -s "$dir/$newname.md" ]]; then
          rm -f "$dir/$newname.md"
          print -ru2 -- "clx: '$newname' left empty — not saved"
        fi
        ;;
      *)
        target="${choice%%  ·  *}"
        action=$(print -rl -- edit rename delete "— back —" \
          | gum choose --header "Prompt '$target':") || continue
        case "$action" in
          edit) "$editor" "$dir/$target.md" ;;
          rename)
            newname=$(gum input --placeholder "new name") || continue
            newname="${${newname## }%% }"; newname="${newname// /-}"
            [[ -z "$newname" || "$newname" == "$target" ]] && continue
            if [[ -f "$dir/$newname.md" ]]; then
              print -ru2 -- "clx: '$newname' already exists"; continue
            fi
            mv "$dir/$target.md" "$dir/$newname.md" \
              && _clx_prompt_repoint "$presets_file" "$target" "$newname"
            ;;
          delete)
            users=$(_clx_prompt_users "$presets_file" "$target")
            if gum confirm --default=false "Delete '$target'${users:+ — used by $users}?"; then
              rm -f "$dir/$target.md"
              _clx_prompt_repoint "$presets_file" "$target" ""
            fi
            ;;
        esac
        ;;
    esac
  done
}

clx() {
  emulate -L zsh
  setopt local_options pipefail
  local clx_dir="${CLX_DIR:-$HOME/.claude/clx}"
  local catalog="${CLX_CATALOG:-$clx_dir/loadout.json}"
  local settings="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
  local presets_file="${CLX_PRESETS:-$clx_dir/presets.json}"
  local prompts_dir="${CLX_PROMPTS_DIR:-$clx_dir/prompts}"
  if [[ "$1" == "ui" || "$1" == "init" || "$1" == "update" || "$1" == "--version" || "$1" == "-v" ]]; then
    local ui_command="$1"
    shift
    local ui_entry="${CLX_UI_BIN:-$_CLX_SOURCE_DIR/bin/clx.mjs}"
    [[ -f "$ui_entry" ]] || ui_entry="$clx_dir/ui-app/node_modules/clx-constellation/bin/clx.mjs"
    command node "$ui_entry" "$ui_command" "$@"
    return $?
  fi
  if [[ -z "$CLX_PROFILE_READY" && -f "$clx_dir/profiles.json" && "$1" != "prompts" ]]; then
    command node "${CLX_UI_BIN:-$_CLX_SOURCE_DIR/bin/clx.mjs}" "$@"
    return $?
  fi
  # Managing prompts needs neither catalog nor plugins, so route before preflight.
  if [[ "$1" == "prompts" ]]; then
    _clx_prompts_manage "$prompts_dir" "$presets_file"
    return $?
  fi

  _clx_preflight "$catalog" || return 1
  local chosen_claude_dir="$(jq -r '.claudeConfigDir // empty' "$catalog")"
  chosen_claude_dir="${chosen_claude_dir:-$CLAUDE_CONFIG_DIR}"
  if [[ -n "$chosen_claude_dir" ]]; then
    local -x CLAUDE_CONFIG_DIR="$chosen_claude_dir"
    settings="$CLAUDE_CONFIG_DIR/settings.json"
    [[ "$CLAUDE_CONFIG_DIR" == "$HOME/.claude" ]] && unset CLAUDE_CONFIG_DIR
  fi

  # ---- Self-heal: plugin updates move the versioned skill cache dirs; a catalog
  # pointing at vanished dirs is stale — regenerate it via bootstrap before the menus.
  local bootstrap="${CLX_BOOTSTRAP:-$clx_dir/bootstrap.zsh}"
  local -a missing_dirs
  missing_dirs=("${(@f)$(_clx_catalog_missing_dirs "$catalog")}"); missing_dirs=("${(@)missing_dirs:#}")
  if (( ${#missing_dirs[@]} )); then
    if [[ -f "$bootstrap" ]]; then
      print -ru2 -- "clx: ${#missing_dirs[@]} skill dir(s) missing (plugin updated?) — refreshing catalog"
      if zsh "$bootstrap" "$catalog" --force >/dev/null 2>&1; then
        missing_dirs=("${(@f)$(_clx_catalog_missing_dirs "$catalog")}"); missing_dirs=("${(@)missing_dirs:#}")
        (( ${#missing_dirs[@]} )) && print -ru2 -- "clx: still missing after refresh: ${missing_dirs[*]}"
      else
        print -ru2 -- "clx: catalog refresh failed — run: zsh $bootstrap --force"
      fi
    else
      print -ru2 -- "clx: skill dirs missing and no bootstrap at '$bootstrap' — catalog may be stale"
    fi
  fi

  local mcp_file settings_file synth_root prompt_file
  mcp_file=$(mktemp "${TMPDIR:-/tmp}/clx-mcp-XXXXXX")
  settings_file=$(mktemp "${TMPDIR:-/tmp}/clx-settings-XXXXXX")
  synth_root=$(mktemp -d "${TMPDIR:-/tmp}/clx-plugins-XXXXXX")
  prompt_file=$(mktemp "${TMPDIR:-/tmp}/clx-prompt-XXXXXX")
  trap 'rm -rf "$mcp_file" "$settings_file" "$synth_root" "$prompt_file"' EXIT INT TERM

  local model_id effort="" preset="" asis=0 quick_model=0 choice action bj sys_prompt=""
  local -a enabled_ids plugin_dir_args mcp_names
  local i n_sp pid pname sentinel mode pdir raw_labels
  local -a labels dirs presel sel_flags bases
  n_sp=$(jq '.skillPlugins | length' "$catalog")

  # ---- Direct invocation: `clx <preset>` launches it as-is, no menus ----
  if (( $# )); then
    local query="$*"
    local -a matches
    matches=("${(@f)$(_clx_match_preset "$presets_file" "$query")}"); matches=("${(@)matches:#}")
    if (( ${#matches[@]} == 1 )); then
      preset="${matches[1]}"; asis=1
    elif (( ${#matches[@]} == 0 )); then
      print -ru2 -- "clx: no preset matches '$query'"
      print -ru2 -- "clx: available presets: $(_clx_preset_names "$presets_file" | paste -sd ', ' -)"
      return 1
    else
      print -ru2 -- "clx: '$query' is ambiguous — matches: ${(j:, :)matches}"
      return 1
    fi
  fi

  # ---- Step 0: preset selection ----
  local -a pnames pdisplay
  local pn
  if [[ -f "$presets_file" ]] && ! jq empty "$presets_file" >/dev/null 2>&1; then
    print -ru2 -- "clx: $presets_file is not valid JSON — skipping preset menu"
  fi
  pnames=("${(@f)$(_clx_preset_names "$presets_file")}"); pnames=("${(@)pnames:#}")
  while [[ -z "$preset" ]] && (( ${#pnames[@]} )); do
    pdisplay=()
    for pn in "${pnames[@]}"; do
      pdisplay+=("$(_clx_preset_display "$presets_file" "$catalog" "$pn")")
    done
    choice=$(print -rl -- "— start blank —" "${pdisplay[@]}" | gum choose --header "Preset:") || return 1
    [[ "$choice" == "— start blank —" ]] && { preset=""; break; }
    choice="${choice%%  ·  *}"
    action=$(print -rl -- "use as-is" "model and effort only (this launch)" "customize" "delete" | gum choose --header "Preset '$choice':") || return 1
    if [[ "$action" == "delete" ]]; then
      if gum confirm --default=false "Delete '$choice'?"; then _clx_delete_preset "$presets_file" "$choice"; fi
      pnames=("${(@f)$(_clx_preset_names "$presets_file")}"); pnames=("${(@)pnames:#}")
      continue
    fi
    preset="$choice"
    [[ "$action" == "use as-is" ]] && asis=1
    [[ "$action" == "model and effort only (this launch)" ]] && { asis=1; quick_model=1; }
    break
  done

  if (( asis )) && [[ "$CLX_PROFILE_READY" == "1" && "$CLX_ALLOW_MISSING" != "1" ]]; then
    local compatibility_output compatibility_code
    compatibility_output=$(command node "$_CLX_SOURCE_DIR/scripts/check-compatibility.mjs" "$catalog" "$presets_file" "$preset")
    compatibility_code=$?
    if (( compatibility_code == 2 )); then
      print -ru2 -- "Unavailable in this Claude profile:"
      print -ru2 -- "$compatibility_output"
      gum confirm --default=false "Continue without these selections? Saved preset stays unchanged." || return 1
    elif (( compatibility_code != 0 )); then
      return 1
    fi
  fi

  if (( asis )); then
    model_id=$(_clx_preset_model "$presets_file" "$preset")
    [[ -z "$model_id" ]] && model_id=$(_clx_model_default "$catalog")
    effort=$(_clx_preset_effort "$presets_file" "$preset")
    if (( quick_model )); then
      local quick_label quick_seed
      quick_seed=$(jq -r --arg id "$model_id" '.models[] | select(.id==$id) | .label' "$catalog")
      quick_label=$(jq -r '.models[].label' "$catalog" | gum choose --header "Model (this launch only):" --selected "$quick_seed") || return 1
      model_id=$(jq -r --arg label "$quick_label" '.models[] | select(.label==$label) | .id' "$catalog")
      effort=$(print -rl -- "(default)" low medium high xhigh max | gum choose --header "Effort (this launch only):" --selected "${effort:-"(default)"}") || return 1
      [[ "$effort" == "(default)" ]] && effort=""
      print -r -- "Using temporary model and effort. Saved preset is unchanged."
    fi
    for (( i=0; i<n_sp; i++ )); do
      pid=$(jq -r ".skillPlugins[$i].id" "$catalog")
      pname=$(jq -r ".skillPlugins[$i].name" "$catalog")
      mode=$(_clx_preset_plugin_mode "$presets_file" "$preset" "$pid")
      case "$mode" in
        full) enabled_ids+=("$pid") ;;
        subset)
          dirs=("${(@f)$(_clx_preset_subset_dirs "$catalog" "$presets_file" "$preset" "$pid")}")
          dirs=("${(@)dirs:#}")
          if (( ${#dirs[@]} )); then
            pdir=$(_clx_build_synth_plugin "$synth_root" "$pname" "${dirs[@]}")
            plugin_dir_args+=(--plugin-dir "$pdir")
          fi ;;
      esac
    done
    enabled_ids+=("${(@f)$(_clx_preset_other_ids "$catalog" "$presets_file" "$preset")}")
    enabled_ids=("${(@)enabled_ids:#}")
    mcp_names=("${(@f)$(_clx_preset_mcp "$presets_file" "$preset")}")
    mcp_names=("${(@)mcp_names:#}")
    sys_prompt=$(_clx_prompt_text "$prompts_dir" "$(_clx_preset_prompt "$presets_file" "$preset")")
  else
    local preset_obj='{"model":"","skillPlugins":{},"otherPlugins":[],"mcp":[]}'

    local seed_label model_label
    if [[ -n "$preset" ]]; then
      seed_label=$(jq -r --arg id "$(_clx_preset_model "$presets_file" "$preset")" '.models[]|select(.id==$id)|.label' "$catalog")
    fi
    [[ -z "$seed_label" ]] && seed_label=$(jq -r '.models[0].label' "$catalog")
    model_label=$(jq -r '.models[].label' "$catalog" \
      | gum choose --header "Model:" --selected "$seed_label") || return 1
    model_id=$(jq -r --arg l "$model_label" '.models[] | select(.label==$l) | .id' "$catalog")
    preset_obj=$(jq --arg m "$model_id" '.model=$m' <<<"$preset_obj")

    # Effort: "(default)" leaves it to Claude Code; a level is passed as --effort.
    local seed_eff
    seed_eff=""
    [[ -n "$preset" ]] && seed_eff=$(_clx_preset_effort "$presets_file" "$preset")
    [[ -z "$seed_eff" ]] && seed_eff="(default)"
    effort=$(print -rl -- "(default)" low medium high xhigh max \
      | gum choose --header "Effort:" --selected "$seed_eff") || return 1
    [[ "$effort" == "(default)" ]] && effort=""
    [[ -n "$effort" ]] && preset_obj=$(jq --arg e "$effort" '.effort=$e' <<<"$preset_obj")
    # Prompt: optional system-prompt addendum, picked by name from prompts/.
    local seed_prompt="" prompt_choice="" prompt_name="" seed_disp="— none —" qn
    [[ -n "$preset" ]] && seed_prompt=$(_clx_preset_prompt "$presets_file" "$preset")
    local -a qnames qdisplay
    qnames=("${(@f)$(_clx_prompt_names "$prompts_dir")}")
    qnames=("${(@)qnames:#}")
    if (( ${#qnames[@]} )); then
      qdisplay=("— none —")
      for qn in "${qnames[@]}"; do qdisplay+=("$(_clx_prompt_display "$prompts_dir" "$qn")"); done
      [[ -n "$seed_prompt" ]] && seed_disp=$(_clx_prompt_display "$prompts_dir" "$seed_prompt")
      prompt_choice=$(print -rl -- "${qdisplay[@]}" \
        | gum choose --header "Prompt:" --selected "$seed_disp") || return 1
      [[ "$prompt_choice" != "— none —" ]] && prompt_name="${prompt_choice%%  ·  *}"
    else
      prompt_name="$seed_prompt"   # no library on disk: keep whatever the preset had
    fi
    sys_prompt=$(_clx_prompt_text "$prompts_dir" "$prompt_name")
    [[ -n "$prompt_name" ]] && preset_obj=$(jq --arg p "$prompt_name" '.prompt=$p' <<<"$preset_obj")

    for (( i=0; i<n_sp; i++ )); do
      pid=$(jq -r ".skillPlugins[$i].id" "$catalog")
      pname=$(jq -r ".skillPlugins[$i].name" "$catalog")
      sentinel="(all $pname)"
      presel=()
      [[ -n "$preset" ]] && { presel=("${(@f)$(_clx_preset_preselect_labels "$catalog" "$presets_file" "$preset" "$pid")}"); presel=("${(@)presel:#}"); }
      sel_flags=("${(@f)$(_clx_selected_args "${presel[@]}")}"); sel_flags=("${(@)sel_flags:#}")
      raw_labels=$( { print -r -- "$sentinel"; jq -r ".skillPlugins[$i].skills[].label" "$catalog"; } \
        | gum choose --no-limit --header "$pname — pick skills, or '$sentinel':" "${sel_flags[@]}") || return 1
      labels=("${(@f)raw_labels}"); labels=("${(@)labels:#}")
      mode=$(_clx_plugin_mode "$sentinel" "${labels[@]}")
      case "$mode" in
        full)
          enabled_ids+=("$pid")
          preset_obj=$(jq --arg id "$pid" '.skillPlugins[$id]={mode:"full"}' <<<"$preset_obj") ;;
        subset)
          dirs=("${(@f)$(_clx_skill_dirs_for_labels "$catalog" "$pid" "${labels[@]}")}"); dirs=("${(@)dirs:#}")
          if (( ${#dirs[@]} )); then
            pdir=$(_clx_build_synth_plugin "$synth_root" "$pname" "${dirs[@]}")
            plugin_dir_args+=(--plugin-dir "$pdir")
            bases=("${(@)dirs:t}")
            bj=$(printf '%s\n' "${bases[@]}" | jq -R . | jq -s .)
            preset_obj=$(jq --arg id "$pid" --argjson sk "$bj" '.skillPlugins[$id]={mode:"subset",skills:$sk}' <<<"$preset_obj")
          else
            print -ru2 -- "clx: no resolvable skill dirs for $pname subset; skipping it"
          fi ;;
        off) ;;
      esac
    done

    local n_other ol oid raw_other
    local -a other_labels other_presel other_sel
    n_other=$(jq '.otherPlugins | length' "$catalog")
    if (( n_other )); then
      other_presel=()
      [[ -n "$preset" ]] && { other_presel=("${(@f)$(_clx_preset_other_names "$catalog" "$presets_file" "$preset")}"); other_presel=("${(@)other_presel:#}"); }
      sel_flags=("${(@f)$(_clx_selected_args "${other_presel[@]}")}"); sel_flags=("${(@)sel_flags:#}")
      raw_other=$(jq -r '.otherPlugins[].name' "$catalog" \
        | gum choose --no-limit --header "Other plugins (no skills to subset):" "${sel_flags[@]}") || return 1
      other_labels=("${(@f)raw_other}"); other_labels=("${(@)other_labels:#}")
      other_sel=()
      for ol in "${other_labels[@]}"; do
        oid=$(jq -r --arg n "$ol" '.otherPlugins[] | select(.name==$n) | .id' "$catalog")
        [[ -n "$oid" ]] && { enabled_ids+=("$oid"); other_sel+=("$oid"); }
      done
      local oj; oj=$(printf '%s\n' "${other_sel[@]}" | jq -R . | jq -s 'map(select(length>0))')
      preset_obj=$(jq --argjson o "$oj" '.otherPlugins=$o' <<<"$preset_obj")
    fi

    local raw_mcp
    local -a mcp_seed
    mcp_seed=()
    [[ -n "$preset" ]] && { mcp_seed=("${(@f)$(_clx_preset_mcp "$presets_file" "$preset")}"); mcp_seed=("${(@)mcp_seed:#}"); }
    sel_flags=("${(@f)$(_clx_selected_args "${mcp_seed[@]}")}"); sel_flags=("${(@)sel_flags:#}")
    raw_mcp=$(jq -r '.mcpServers | keys[]' "$catalog" \
      | gum choose --no-limit --header "MCP servers (none = off):" "${sel_flags[@]}") || return 1
    mcp_names=("${(@f)raw_mcp}"); mcp_names=("${(@)mcp_names:#}")
    local mj; mj=$(printf '%s\n' "${mcp_names[@]}" | jq -R . | jq -s 'map(select(length>0))')
    preset_obj=$(jq --argjson m "$mj" '.mcp=$m' <<<"$preset_obj")

    if [[ -n "$preset" && "$CLX_PROFILE_READY" == "1" ]]; then
      preset_obj=$(command node "$_CLX_SOURCE_DIR/scripts/preserve-unavailable.mjs" "$catalog" "$presets_file" "$preset" "$preset_obj") || return 1
    fi

    # Save: customizing an existing preset offers an in-place update; starting
    # blank keeps the confirm+name flow. Esc/decline anywhere still launches.
    local save_choice="" sname
    if [[ -n "$preset" ]]; then
      save_choice=$(print -rl -- "Update '$preset'" "Save as new preset" "Don't save" \
        | gum choose --header "Save changes?") || save_choice=""
    elif gum confirm --default=false "Save as preset?"; then
      save_choice="Save as new preset"
    fi
    case "$save_choice" in
      "Update '"*)
        _clx_save_preset "$presets_file" "$preset" "$preset_obj" ;;
      "Save as new preset")
        sname=$(gum input --placeholder "preset name") || sname=""
        if [[ -n "$sname" ]]; then
          if [[ -f "$presets_file" ]] && jq -e --arg n "$sname" 'has($n)' "$presets_file" >/dev/null 2>&1; then
            gum confirm --default=false "Overwrite '$sname'?" && _clx_save_preset "$presets_file" "$sname" "$preset_obj"
          else
            _clx_save_preset "$presets_file" "$sname" "$preset_obj"
          fi
        fi ;;
    esac
  fi

  _clx_mcp_config_json "$catalog" "${mcp_names[@]}" > "$mcp_file"
  if [[ -f "$settings" ]]; then
    jq -s '.[0] * .[1]' "$settings" =(_clx_enabled_plugins_json "$catalog" "${enabled_ids[@]}") > "$settings_file"
  else
    jq -s '.[0] * .[1]' =(echo '{}') =(_clx_enabled_plugins_json "$catalog" "${enabled_ids[@]}") > "$settings_file"
  fi

  local -a effort_args prompt_args
  [[ -n "$effort" ]] && effort_args=(--effort "$effort")
  if [[ -n "$sys_prompt" ]]; then
    print -r -- "$sys_prompt" > "$prompt_file"
    prompt_args=(--append-system-prompt-file "$prompt_file")
  fi

  print -r -- "clx → model=$model_id  effort=${effort:-default}  enabled=(${enabled_ids[*]:-none})  subset-dirs=${#plugin_dir_args[@]}  mcp=(${mcp_names[*]:-none})  prompt=$([[ -n "$sys_prompt" ]] && echo yes || echo no)"
  "${CLX_CLAUDE_BIN:-claude}" --model "$model_id" "${effort_args[@]}" "${prompt_args[@]}" \
    --strict-mcp-config --mcp-config "$mcp_file" \
    --settings "$settings_file" \
    "${plugin_dir_args[@]}"

  rm -rf "$mcp_file" "$settings_file" "$synth_root" "$prompt_file"
  trap - EXIT INT TERM
}

# Tab completion: complete preset names for `clx <TAB>`.
# Registers only if compinit has already run when this file is sourced.
_clx_completion() {
  local clx_dir="${CLX_DIR:-$HOME/.claude/clx}"
  local presets_file="${CLX_PRESETS:-$clx_dir/presets.json}"
  local -a names
  names=("${(@f)$(_clx_preset_names "$presets_file")}"); names=("${(@)names:#}")
  names+=("prompts")
  compadd -a names
}
if (( $+functions[compdef] )); then
  compdef _clx_completion clx 2>/dev/null || true
fi
