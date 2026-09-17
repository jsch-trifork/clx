#!/usr/bin/env zsh
emulate -L zsh
setopt null_glob
local here="${0:A:h}"
source "$here/assert.zsh"
source "$here/../clx.zsh"
for f in "$here"/test_*.zsh; do source "$f"; done
print -r -- "----"
print -r -- "$(( CLX_TESTS - CLX_FAILS ))/$CLX_TESTS passed"
(( CLX_FAILS == 0 ))
