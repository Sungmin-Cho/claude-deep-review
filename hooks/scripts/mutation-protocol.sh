#!/usr/bin/env bash
# mutation-protocol.sh — shared Bash library for deep-review mutation/restore/auto-R

# EMPTY_BLOB_SHA is git's well-known hash for an empty blob (0-byte file content)
# Identical across all git versions.
EMPTY_BLOB_SHA="e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"

# EMPTY_TREE_SHA is git's well-known hash for an empty tree (used as HEAD fallback in initial repo)
# Canonical value: sha1("tree 0\0") = 4b825dc642cb6eb9a060e54bf8d69288fbee4904
# (This is a built-in constant in git; works without the object existing in the object DB.)
# NOTE: The plan had a typo (...bf899d69f7cb46617) which is not a real tree object. Fixed here.
EMPTY_TREE_SHA="4b825dc642cb6eb9a060e54bf8d69288fbee4904"

# is_our_ita_entry <file>
#   Returns 0 if the given file is in index as an intent-to-add entry (git add -N).
#   Returns 1 otherwise (not in index, or real staged content).
#
#   Detection: git diff-index --cached --raw outputs "src-mode dst-mode src-hash dst-hash status path"
#   For intent-to-add, src-mode is ":000000" and dst-hash is the empty-blob SHA.
is_our_ita_entry() {
  local file="$1"
  local tree="HEAD"
  git rev-parse --verify HEAD >/dev/null 2>&1 || tree="$EMPTY_TREE_SHA"

  local line
  line=$(git diff-index --cached --raw "$tree" -- "$file" 2>/dev/null | head -1)
  [ -z "$line" ] && return 1

  local src_mode dst_hash
  src_mode=$(awk '{print $1}' <<<"$line")
  dst_hash=$(awk '{print $4}' <<<"$line")

  if [ "$src_mode" = ":000000" ] && [ "$dst_hash" = "$EMPTY_BLOB_SHA" ]; then
    return 0
  fi
  return 1
}
