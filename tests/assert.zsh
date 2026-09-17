typeset -gi CLX_TESTS=0 CLX_FAILS=0

assert_json_eq() {
  # $1 = description, $2 = actual JSON, $3 = expected JSON
  (( CLX_TESTS++ ))
  local a e
  a=$(print -r -- "$2" | jq -S -c .) || { print -ru2 -- "FAIL [$1]: actual not JSON"; (( CLX_FAILS++ )); return; }
  e=$(print -r -- "$3" | jq -S -c .) || { print -ru2 -- "FAIL [$1]: expected not JSON"; (( CLX_FAILS++ )); return; }
  if [[ "$a" == "$e" ]]; then
    print -r -- "PASS [$1]"
  else
    print -ru2 -- "FAIL [$1]: got $a want $e"; (( CLX_FAILS++ ))
  fi
}

assert_eq() {
  (( CLX_TESTS++ ))
  if [[ "$2" == "$3" ]]; then print -r -- "PASS [$1]"
  else print -ru2 -- "FAIL [$1]: got '$2' want '$3'"; (( CLX_FAILS++ )); fi
}
