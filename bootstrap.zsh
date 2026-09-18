#!/usr/bin/env zsh
emulate -L zsh
setopt err_exit pipefail null_glob
umask 077
command -v jq >/dev/null || { print -ru2 -- "clx init requires jq. Install jq and retry."; exit 1; }
local out force
for arg in "$@"; do
  if [[ "$arg" == "--force" ]]; then force="--force"
  else out="$arg"
  fi
done
out="${out:-$HOME/.claude/clx/loadout.json}"
if [[ -f "$out" && "$force" != "--force" ]]; then
  print -ru2 -- "bootstrap: $out exists (pass --force to overwrite)"; return 1 2>/dev/null || exit 1
fi
local claude_dir="${CLAUDE_CONFIG_DIR:-}"
[[ -z "$claude_dir" && -f "$out" ]] && claude_dir=$(jq -r '.claudeConfigDir // empty' "$out")
if [[ -n "$claude_dir" ]]; then
  [[ "$claude_dir" == '~/'* ]] && claude_dir="$HOME/${claude_dir#\~/}"
  [[ -d "$claude_dir" || "$claude_dir" == "$HOME/.claude" ]] || { print -ru2 -- "Claude configuration folder does not exist: $claude_dir"; exit 1; }
  claude_dir="${claude_dir:a}"
fi
local source_dir="${claude_dir:-$HOME/.claude}"
local settings="$source_dir/settings.json" cfg="$HOME/.claude.json"
[[ -n "$claude_dir" && "$claude_dir" != "$HOME/.claude" ]] && cfg="$claude_dir/.claude.json"
local cache="$source_dir/plugins/cache"
local installed="$source_dir/plugins/installed_plugins.json"

# Reject malformed configuration before replacing an existing catalog.
for config_file in "$settings" "$cfg"; do
  if [[ -f "$config_file" ]]; then
    jq -e 'type == "object"' "$config_file" >/dev/null || { print -ru2 -- "Invalid Claude configuration: $config_file"; exit 1; }
  fi
done

# mcpServers: global + per-project, merged.
local mcp='{}'
[[ -f "$cfg" ]] && mcp=$(jq -n --slurpfile c "$cfg" '
  ($c[0].mcpServers // {}) as $g
  | ($c[0].projects // {} | [to_entries[].value.mcpServers // {}] | add // {}) as $p
  | $g + $p')

# Build skillPlugins[] and otherPlugins[] from enabledPlugins keys.
local skill_plugins='[]' other_plugins='[]'
if [[ -f "$settings" ]]; then
  local key name marketplace root manifest pname sd sr base desc skills_json
  local -a sdirs
  for key in ${(f)"$(jq -r '.enabledPlugins // {} | keys[]' "$settings")"}; do
    name="${key%@*}"; marketplace="${key#*@}"
    # Prefer the path Claude Code actually loads (installed_plugins.json). Globbing the
    # cache and taking the highest version silently pins the catalog to whatever was
    # newest when it was generated, which can otherwise select an outdated version.
    root=$(jq -r --arg k "$key" '.plugins[$k][0].installPath // empty' "$installed" 2>/dev/null || true)
    [[ -n "$root" && -d "$root" ]] && root="${root%/}/" || root=""
    [[ -z "$root" ]] && root=$(ls -d "$cache/$marketplace/$name"/*/ 2>/dev/null | sort -V | tail -1)
    [[ -z "$root" ]] && continue
    manifest="${root}.claude-plugin/plugin.json"
    pname=$(jq -r '.name // empty' "$manifest" 2>/dev/null || true); [[ -z "$pname" ]] && pname="$name"
    # Skill dirs: honour the manifest's "skills" field (string or array, relative to
    # the plugin root) before falling back to the conventional ./skills. ui-ux-pro-max
    # ships them under ./.claude/skills/, which the old hardcoded path missed.
    sdirs=()
    for sr in ${(f)"$(jq -r '(.skills // empty) | if type=="array" then .[] else . end' "$manifest" 2>/dev/null || true)"}; do
      [[ -z "$sr" ]] && continue
      sr="${sr#./}"; sr="${sr%/}"
      [[ "$sr" != /* ]] && sr="${root}${sr}"
      [[ -d "$sr" ]] && sdirs+=("$sr")
    done
    if (( ${#sdirs[@]} == 0 )) && [[ -d "${root}skills" ]]; then sdirs=("${root%/}/skills"); fi
    if (( ${#sdirs[@]} )); then
      skills_json=$(
        for sd in "${(@)sdirs}"/*/; do
          [[ -f "${sd}SKILL.md" ]] || continue
          base=${${sd%/}:t}
          desc=$(awk 'f&&/^description:/{sub(/^description:[[:space:]]*/,"");gsub(/^"|"$/,"");print;exit} /^---/{f++}' "${sd}SKILL.md")
          desc=${desc//,/;}
          desc=${desc[1,90]}
          jq -n --arg dir "${sd%/}" --arg label "$base — ${desc:-}" '{dir:$dir,label:$label}'
        done | jq -s '.'
      )
      skill_plugins=$(jq --arg id "$key" --arg n "$pname" --argjson sk "${skills_json:-[]}" \
        '. + [{id:$id, name:$n, skills:$sk}]' <<<"$skill_plugins")
    else
      other_plugins=$(jq --arg id "$key" --arg n "$pname" \
        '. + [{id:$id, name:$n}]' <<<"$other_plugins")
    fi
  done
fi

# Claude Code aliases resolve on the user's own provider and account.
# No credentials or network request are needed to build a catalog.
local models='[
  {"id":"sonnet","label":"Sonnet (default)"},
  {"id":"opus","label":"Opus"},
  {"id":"haiku","label":"Haiku"}
]'
mkdir -p "${out:h}"
local temp_out=$(mktemp "${out}.tmp.XXXXXX")
jq -n --arg claudeConfigDir "$source_dir" --argjson models "$models" --argjson mcp "$mcp" --argjson sp "$skill_plugins" --argjson op "$other_plugins" '{
  claudeConfigDir: (if $claudeConfigDir == "" then null else $claudeConfigDir end),
  models: $models,
  mcpServers: $mcp,
  skillPlugins: $sp,
  otherPlugins: $op
}' > "$temp_out"
mv "$temp_out" "$out"
print -r -- "bootstrap: wrote $out"
