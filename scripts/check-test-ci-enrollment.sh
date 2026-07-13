#!/usr/bin/env bash
# Fail closed when a legacy shell test is unreachable from CI.
#
# Enrollment sources:
#   1. a direct workflow run step invoking a test with bash/sh;
#   2. a package script reached by a workflow run step; or
#   3. the canonical recursive aggregate, but only when that aggregate is
#      reached by one of those workflow/package edges.
#
# test-helpers.sh is the sole standalone-execution exclusion. The aggregate
# must discover hooks/scripts/test/test-*.sh recursively and propagate failure.
set -Eeuo pipefail

if [ "$#" -gt 0 ]; then
  ROOT="$1"
else
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
TEST_DIR="$ROOT/hooks/scripts/test"
WF_DIR="$ROOT/.github/workflows"
PKG="$ROOT/package.json"
AGGREGATE="$ROOT/scripts/run-all-tests.sh"

if [ ! -d "$TEST_DIR" ] || [ ! -d "$WF_DIR" ] || [ ! -f "$PKG" ]; then
  echo "❌ enrollment inputs are incomplete under $ROOT" >&2
  exit 1
fi

# Only run-step declarations are eligible; path filters and comments are not.
wf_runs="$(grep -hE '^[[:space:]]*(-[[:space:]]+)?run:' "$WF_DIR"/*.yml 2>/dev/null || true)"

reachable_names="$(
  {
    printf '%s\n' "$wf_runs" \
      | grep -Eq 'npm[[:space:]]+test([^[:alnum:]:._-]|$)' \
      && printf 'test\n' || true
    printf '%s\n' "$wf_runs" \
      | grep -oE 'npm[[:space:]]+run[[:space:]]+[A-Za-z0-9:._/-]+' \
      | sed -E 's/^npm[[:space:]]+run[[:space:]]+//' || true
  } | sort -u
)"

# Node is the supported runtime floor; do not introduce a Python/jq dependency
# merely to resolve the reached package-script values.
reachable_values="$(
  REACHABLE_NAMES="$reachable_names" node -e '
    const fs = require("node:fs");
    const names = new Set((process.env.REACHABLE_NAMES || "").split(/\r?\n/u).filter(Boolean));
    const parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const scripts = parsed.scripts || {};
    for (const name of names) {
      if (Object.hasOwn(scripts, name) && typeof scripts[name] === "string") {
        process.stdout.write(scripts[name] + "\n");
      }
    }
  ' "$PKG"
)"

corpus="$(printf '%s\n%s\n' "$wf_runs" "$reachable_values")"

# Any shell file in this test directory must use the test-*.sh convention.
# This prevents a second hidden corpus from silently escaping the aggregate.
hidden=""
for candidate in "$TEST_DIR"/*.sh; do
  [ -e "$candidate" ] || continue
  case "$(basename "$candidate")" in
    test-*.sh) ;;
    *) hidden="$hidden
$(basename "$candidate")" ;;
  esac
done
if [ -n "$hidden" ]; then
  echo "❌ hidden shell tests/helpers outside test-*.sh:" >&2
  printf '%s\n' "$hidden" | sed '/^$/d; s/^/   - /' >&2
  exit 1
fi

aggregate_reached=false
if printf '%s\n' "$corpus" \
  | grep -Eq '(bash|sh)[[:space:]]+[^[:space:]]*scripts/run-all-tests\.sh([^[:alnum:]._-]|$)'; then
  aggregate_reached=true
fi

if [ "$aggregate_reached" = true ]; then
  if [ ! -f "$AGGREGATE" ]; then
    echo "❌ reached recursive aggregate is missing: scripts/run-all-tests.sh" >&2
    exit 1
  fi
  continue_count=$(grep -c 'continue' "$AGGREGATE" || true)
  if ! grep -qF 'for t in hooks/scripts/test/test-*.sh' "$AGGREGATE" \
     || ! grep -q 'test-helpers\.sh).*continue\|test-helpers\.sh).*; continue' "$AGGREGATE" \
     || [ "$continue_count" -ne 1 ] \
     || ! grep -qE 'bash[[:space:]]+"\$t"[[:space:]]*\|\|[[:space:]]*fail=1' "$AGGREGATE" \
     || ! grep -qE 'fail.*(exit 1|\-eq 0)' "$AGGREGATE"; then
    echo "❌ reached scripts/run-all-tests.sh is not the fail-closed recursive aggregate" >&2
    exit 1
  fi
fi

missing=""
for test_path in "$TEST_DIR"/test-*.sh; do
  [ -e "$test_path" ] || continue
  base="$(basename "$test_path")"
  case "$base" in
    test-helpers.sh) continue ;;
  esac
  if [ "$aggregate_reached" = true ]; then
    continue
  fi
  base_re=$(printf '%s' "$base" | sed 's/\./\\./g')
  if ! printf '%s\n' "$corpus" \
    | grep -Eq "(bash|sh)[[:space:]]+[^[:space:]]*$base_re([^[:alnum:]._-]|$)"; then
    missing="$missing
$base"
  fi
done

if [ -n "$missing" ]; then
  echo "❌ CI-unreachable legacy tests:" >&2
  printf '%s\n' "$missing" | sed '/^$/d; s/^/   - /' >&2
  echo "   → reach scripts/run-all-tests.sh through npm run test:legacy or invoke the test directly." >&2
  exit 1
fi

echo "✅ every legacy test is reachable; recursive aggregate=$aggregate_reached"
