#!/bin/zsh
# Docker workspaces: `clx -w NAME --docker` (and "docker": true) run the session
# through scripts/docker-run.mjs instead of claude; the guards refuse the unsafe
# combinations. The docker runner is stubbed via CLX_DOCKER_RUN, so no container runs.

() {
  local work=$(mktemp -d) out=$(mktemp -d) stub=$(mktemp -d)
  work=${work:A}
  mkdir -p "$work/home/code/org/present" "$work/home/code/org/ui"

  local cat="$work/loadout.json" pf="$work/presets.json" wf="$work/workspaces.json"
  jq -n '{ models:[{id:"claude-sonnet-4-6",label:"Sonnet"}], mcpServers:{}, skillPlugins:[], otherPlugins:[] }' > "$cat"
  jq -n '{p1:{model:"claude-sonnet-4-6",skillPlugins:{},otherPlugins:[],mcp:[]}}' > "$pf"
  jq -n '{fence:["~/code"], workspaces:{
      present:{start:"~/code/org/present", dirs:["~/code/org/ui"]},
      boxed:{start:"~/code/org/present", docker:true}
    }}' > "$wf"

  # claude stub: answers --version; otherwise would be the non-docker runner.
  cat > "$stub/claude" <<EOF
#!/bin/zsh
emulate -L zsh
if [[ "\$1" == --version ]]; then print -r -- "2.1.281 (Claude Code)"; exit 0; fi
print -r -- "claude \$*" > "$out/ran"
print -r -- "claude" > "$out/runner"
exit 0
EOF
  chmod +x "$stub/claude"

  # docker-run stub: a node script that records it was the runner, with its leading
  # positional args (workspaces file, workspace name) and the claude args after --.
  cat > "$stub/docker-run.mjs" <<EOF
import { writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const i = argv.indexOf("--");
writeFileSync("$out/runner", "docker\n");
writeFileSync("$out/ran", "docker " + argv.join(" ") + "\n");
writeFileSync("$out/docker_ws", (argv[1] ?? "") + "\n");
EOF

  # gum stub: drives the workspace review screen from a per-call answer file.
  cat > "$stub/gum" <<EOF
#!/bin/zsh
emulate -L zsh
pop() { print -r -- "\$(head -1 "\$1")"; tail -n +2 "\$1" > "\$1.t"; mv "\$1.t" "\$1"; }
[[ "\$1" == choose ]] && cat >/dev/null
local header=""
while (( \$# )); do case "\$1" in --header) header="\$2"; shift 2;; --selected) shift 2;; *) shift;; esac; done
print -r -- "\$header" >> "$out/menus"
case "\$header" in
  "Preset:")     print -r -- "p1" ;;
  "Preset '"*)   print -r -- "use as-is" ;;
  "Workspace:")  print -r -- "present" ;;
  "Workspace '"*) if [[ -s "$out/review_seq" ]]; then pop "$out/review_seq"; else print -r -- "Start"; fi ;;
esac
exit 0
EOF
  chmod +x "$stub/gum"

  local -x HOME="$work/home" CLX_CATALOG="$cat" CLX_PRESETS="$pf" CLX_WORKSPACES="$wf"
  local -x CLX_DOCKER_RUN="$stub/docker-run.mjs"

  # --- --docker runs the docker runner, not claude, scoped to the workspace ---
  rm -f "$out/runner" "$out/ran" "$out/docker_ws"
  ( PATH="$stub:$PATH"; clx -w present --docker p1 >/dev/null 2>&1 )
  assert_eq "docker_flag_exit" "$?" "0"
  assert_eq "docker_flag_uses_runner" "$(<"$out/runner")" "docker"
  assert_eq "docker_flag_passes_workspace" "$(<"$out/docker_ws")" "present"
  assert_eq "docker_flag_passes_claude_args" \
    "$([[ "$(<"$out/ran")" == *"-- --model claude-sonnet-4-6"* ]] && echo yes)" "yes"

  # --- "docker": true on the workspace runs the runner with no flag ---
  rm -f "$out/runner"
  ( PATH="$stub:$PATH"; clx -w boxed p1 >/dev/null 2>&1 )
  assert_eq "docker_setting_uses_runner" "$(<"$out/runner")" "docker"

  # --- --docker without -w is refused: it needs a workspace to pick folders ---
  rm -f "$out/runner"
  ( PATH="$stub:$PATH"; clx --docker p1 >/dev/null 2>"$out/err" )
  assert_eq "docker_no_ws_exit" "$?" "1"
  assert_eq "docker_no_ws_msg" "$(grep -c 'needs a workspace' "$out/err")" "1"
  assert_eq "docker_no_ws_no_run" "$([[ -f "$out/runner" ]] && echo ran)" ""

  # --- --docker with --chrome is refused: the browser lives outside the container ---
  rm -f "$out/runner"
  ( PATH="$stub:$PATH"; clx -w present --docker --chrome p1 >/dev/null 2>"$out/err" )
  assert_eq "docker_chrome_exit" "$?" "1"
  assert_eq "docker_chrome_msg" "$(grep -c "doesn't work in a docker workspace" "$out/err")" "1"
  assert_eq "docker_chrome_no_run" "$([[ -f "$out/runner" ]] && echo ran)" ""

  # --- A "docker": true workspace refuses --chrome the same way ---
  rm -f "$out/runner"
  ( PATH="$stub:$PATH"; clx -w boxed --chrome p1 >/dev/null 2>"$out/err" )
  assert_eq "docker_setting_chrome_exit" "$?" "1"
  assert_eq "docker_setting_chrome_no_run" "$([[ -f "$out/runner" ]] && echo ran)" ""

  # --- Review screen: turning Docker on for the launch routes to the runner ---
  rm -f "$out/runner" "$out/menus"
  print -rl -- "Run in Docker for this launch (experimental)" "Start" > "$out/review_seq"
  ( PATH="$stub:$PATH"; clx >/dev/null 2>"$out/review_err" )
  assert_eq "docker_review_exit" "$?" "0"
  assert_eq "docker_review_uses_runner" "$(<"$out/runner")" "docker"
  # Chrome is shown as unavailable once Docker is on for the launch.
  assert_eq "docker_review_chrome_off" "$(grep -c 'not available in Docker' "$out/review_err")" "1"

  # --- Review screen: a "docker": true workspace shows Docker fixed on, Chrome off ---
  rm -f "$out/runner" "$out/menus"
  print -rl -- "Start" > "$out/review_seq"
  # Pick 'boxed' from the workspace menu this time.
  cat > "$stub/gum" <<EOF
#!/bin/zsh
emulate -L zsh
pop() { print -r -- "\$(head -1 "\$1")"; tail -n +2 "\$1" > "\$1.t"; mv "\$1.t" "\$1"; }
[[ "\$1" == choose ]] && cat >/dev/null
local header=""
while (( \$# )); do case "\$1" in --header) header="\$2"; shift 2;; --selected) shift 2;; *) shift;; esac; done
print -r -- "\$header" >> "$out/menus"
case "\$header" in
  "Preset:")      print -r -- "p1" ;;
  "Preset '"*)    print -r -- "use as-is" ;;
  "Workspace:")   print -r -- "boxed" ;;
  "Workspace '"*) if [[ -s "$out/review_seq" ]]; then pop "$out/review_seq"; else print -r -- "Start"; fi ;;
esac
exit 0
EOF
  chmod +x "$stub/gum"
  ( PATH="$stub:$PATH"; clx >/dev/null 2>"$out/review_err" )
  assert_eq "docker_review_fixed_exit" "$?" "0"
  assert_eq "docker_review_fixed_runner" "$(<"$out/runner")" "docker"
  assert_eq "docker_review_fixed_note" "$(grep -c 'set in the workspace' "$out/review_err")" "1"

  rm -rf "$work" "$out" "$stub"
}
