#!/usr/bin/env bash
# Assemble a reviewer payload in a FIXED order so the bulky diff is LAST
# (instruction-attention: reviewers read doctrine/rules before the diff).
set -Eeuo pipefail

doctrine=""; change_files=""; context=""; diff=""
while [ $# -gt 0 ]; do
  case "$1" in
    --doctrine-file) doctrine="${2:-}"; shift 2;;
    --change-files-file) change_files="${2:-}"; shift 2;;
    --context-file) context="${2:-}"; shift 2;;
    --diff-file) diff="${2:-}"; shift 2;;
    *) echo "build-reviewer-payload: unknown arg: $1" >&2; exit 2;;
  esac
done

section() { # title, file
  [ -n "$2" ] && [ -s "$2" ] || return 0
  printf '\n===== %s =====\n' "$1"
  cat "$2"
  printf '\n'
}

# Order is load-bearing — diff LAST.
section "REVIEW SUPPRESSION DOCTRINE" "$doctrine"
section "CHANGED FILES (cross-file context)" "$change_files"
section "PROJECT RULES / CONTRACT / HEALTH" "$context"
section "DIFF UNDER REVIEW" "$diff"
