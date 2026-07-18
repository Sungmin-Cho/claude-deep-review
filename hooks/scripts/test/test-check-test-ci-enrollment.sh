#!/usr/bin/env bash
# Recursive aggregate reachability tests for the CI-enrollment guard.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"
GUARD="$(cd "$SCRIPT_DIR/../../.." && pwd)/scripts/check-test-ci-enrollment.sh"

new_fixture() {
  local root
  root=$(mktemp -d "/tmp/ci-enroll.XXXXXX")
  mkdir -p "$root/hooks/scripts/test" "$root/.github/workflows" "$root/scripts"
  printf '%s\n' "$root"
}

write_aggregate() {
  local root="$1"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'fail=0' \
    'for t in hooks/scripts/test/test-*.sh; do' \
    '  case "$(basename "$t")" in test-helpers.sh) continue ;; esac' \
    '  bash "$t" || fail=1' \
    'done' \
    '[ "$fail" -eq 0 ]' \
    > "$root/scripts/run-all-tests.sh"
}

# 1. A workflow-reached recursive aggregate enrolls every matching test.
fx=$(new_fixture)
: > "$fx/hooks/scripts/test/test-alpha.sh"
: > "$fx/hooks/scripts/test/test-helpers.sh"
write_aggregate "$fx"
printf '%s\n' '      - run: npm run test:legacy' > "$fx/.github/workflows/tests.yml"
printf '%s\n' '{"scripts":{"test":"node --test","test:legacy":"bash scripts/run-all-tests.sh"}}' > "$fx/package.json"
assert_success "bash '$GUARD' '$fx'" "reached recursive aggregate enrolls existing test"

# 2. Adding another test requires no workflow or package edit: the glob reaches it.
: > "$fx/hooks/scripts/test/test-beta.sh"
assert_success "bash '$GUARD' '$fx'" "reached aggregate auto-discovers newly added test"
rm -rf "$fx"

# 3. Merely defining test:legacy is insufficient when no workflow invokes it.
fx=$(new_fixture)
: > "$fx/hooks/scripts/test/test-gamma.sh"
write_aggregate "$fx"
printf '%s\n' '      - run: npm test' > "$fx/.github/workflows/tests.yml"
printf '%s\n' '{"scripts":{"test":"node --test","test:legacy":"bash scripts/run-all-tests.sh"}}' > "$fx/package.json"
assert_failure "bash '$GUARD' '$fx'" "unreachable aggregate does not enroll tests"
rm -rf "$fx"

# 4. A reached aggregate that does not recurse over the canonical glob is invalid.
fx=$(new_fixture)
: > "$fx/hooks/scripts/test/test-delta.sh"
printf '%s\n' '#!/usr/bin/env bash' 'bash hooks/scripts/test/test-delta.sh' > "$fx/scripts/run-all-tests.sh"
printf '%s\n' '      - run: npm run test:legacy' > "$fx/.github/workflows/tests.yml"
printf '%s\n' '{"scripts":{"test:legacy":"bash scripts/run-all-tests.sh"}}' > "$fx/package.json"
assert_failure "bash '$GUARD' '$fx'" "non-recursive aggregate is rejected"
rm -rf "$fx"

# 5. A hidden shell test outside test-*.sh is rejected rather than silently skipped.
fx=$(new_fixture)
: > "$fx/hooks/scripts/test/test-epsilon.sh"
: > "$fx/hooks/scripts/test/hidden-epsilon.sh"
write_aggregate "$fx"
printf '%s\n' '      - run: npm run test:legacy' > "$fx/.github/workflows/tests.yml"
printf '%s\n' '{"scripts":{"test:legacy":"bash scripts/run-all-tests.sh"}}' > "$fx/package.json"
assert_failure "bash '$GUARD' '$fx'" "hidden non-test shell script is rejected"
rm -rf "$fx"

# 6. test-helpers.sh is the sole standalone-execution exclusion.
fx=$(new_fixture)
: > "$fx/hooks/scripts/test/test-helpers.sh"
: > "$fx/.github/workflows/tests.yml"
printf '%s\n' '{"scripts":{"test":"node --test"}}' > "$fx/package.json"
assert_success "bash '$GUARD' '$fx'" "test-helpers-only fixture needs no aggregate"
rm -rf "$fx"

# 7. Bare path-filter or comment mentions do not count as execution.
fx=$(new_fixture)
: > "$fx/hooks/scripts/test/test-zeta.sh"
printf '%s\n' \
  'on:' \
  '  pull_request:' \
  '    paths:' \
  '      - hooks/scripts/test/test-zeta.sh' \
  '# test-zeta.sh' \
  > "$fx/.github/workflows/tests.yml"
printf '%s\n' '{"scripts":{"test":"node --test"}}' > "$fx/package.json"
assert_failure "bash '$GUARD' '$fx'" "path-filter and comment mentions are not enrollment"
rm -rf "$fx"

# 8. A direct workflow invocation remains a valid explicit enrollment.
fx=$(new_fixture)
: > "$fx/hooks/scripts/test/test-eta.sh"
printf '%s\n' '      - run: bash hooks/scripts/test/test-eta.sh' > "$fx/.github/workflows/tests.yml"
printf '%s\n' '{"scripts":{"test":"node --test"}}' > "$fx/package.json"
assert_success "bash '$GUARD' '$fx'" "direct workflow execution remains enrolled"
rm -rf "$fx"

test_summary
