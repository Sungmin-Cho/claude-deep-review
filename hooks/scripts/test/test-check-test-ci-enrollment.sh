#!/usr/bin/env bash
# test-check-test-ci-enrollment.sh — scripts/check-test-ci-enrollment.sh 단위 테스트.
# 이 파일 자신도 hooks/scripts/test/test-*.sh 이므로 가드의 대상이 된다 →
# tests.yml 에 자기 스텝이 등록돼야 가드가 green(자기 부트스트랩).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"
# repo 루트 기준(cwd·git 비의존): hooks/scripts/test → ../../.. = repo root
GUARD="$(cd "$SCRIPT_DIR/../../.." && pwd)/scripts/check-test-ci-enrollment.sh"

# fixture 1: 모든 테스트가 등록됨(+ test-helpers 는 제외 대상) → pass
fx=$(mktemp -d "${TMPDIR:-/tmp}/ci-enroll.XXXXXX")
mkdir -p "$fx/hooks/scripts/test" "$fx/.github/workflows"
: > "$fx/hooks/scripts/test/test-alpha.sh"
: > "$fx/hooks/scripts/test/test-helpers.sh"
printf '      - run: bash hooks/scripts/test/test-alpha.sh\n' > "$fx/.github/workflows/tests.yml"
printf '{"scripts":{"test":"noop"}}\n' > "$fx/package.json"
assert_success "bash '$GUARD' '$fx'" "모든 테스트 등록 시 pass"
rm -rf "$fx"

# fixture 2: test-beta.sh 미등록 → fail
fx=$(mktemp -d "${TMPDIR:-/tmp}/ci-enroll.XXXXXX")
mkdir -p "$fx/hooks/scripts/test" "$fx/.github/workflows"
: > "$fx/hooks/scripts/test/test-alpha.sh"
: > "$fx/hooks/scripts/test/test-beta.sh"
printf '        run: bash hooks/scripts/test/test-alpha.sh\n' > "$fx/.github/workflows/tests.yml"
printf '{"scripts":{"test":"noop"}}\n' > "$fx/package.json"
assert_failure "bash '$GUARD' '$fx'" "미등록 테스트 존재 시 fail"
rm -rf "$fx"

# fixture 3: test-helpers.sh 만 있으면(제외 대상) 여전히 pass(제외 규칙 경계)
fx=$(mktemp -d "${TMPDIR:-/tmp}/ci-enroll.XXXXXX")
mkdir -p "$fx/hooks/scripts/test" "$fx/.github/workflows"
: > "$fx/hooks/scripts/test/test-helpers.sh"
printf '{}\n' > "$fx/package.json"
: > "$fx/.github/workflows/tests.yml"
assert_success "bash '$GUARD' '$fx'" "test-helpers.sh 제외 규칙(경계)"
rm -rf "$fx"

# fixture 4 (plan-R1): paths 필터/주석에만 파일명 언급 → 등록 아님 → fail
fx=$(mktemp -d "${TMPDIR:-/tmp}/ci-enroll.XXXXXX")
mkdir -p "$fx/hooks/scripts/test" "$fx/.github/workflows"
: > "$fx/hooks/scripts/test/test-gamma.sh"
printf 'on:\n  pull_request:\n    paths:\n      - hooks/scripts/test/test-gamma.sh\n# comment: test-gamma.sh\n' \
  > "$fx/.github/workflows/tests.yml"
printf '{"scripts":{"test":"noop"}}\n' > "$fx/package.json"
assert_failure "bash '$GUARD' '$fx'" "paths 필터/주석 언급은 등록으로 인정 안 함(오판 차단)"
rm -rf "$fx"

# fixture 5: npm test 편입(package.json scripts 값의 bash 호출)로 등록 → pass
fx=$(mktemp -d "${TMPDIR:-/tmp}/ci-enroll.XXXXXX")
mkdir -p "$fx/hooks/scripts/test" "$fx/.github/workflows"
: > "$fx/hooks/scripts/test/test-delta.sh"
printf '      - run: npm test\n' > "$fx/.github/workflows/tests.yml"
printf '{"scripts":{"test":"node --test && bash hooks/scripts/test/test-delta.sh"}}\n' > "$fx/package.json"
assert_success "bash '$GUARD' '$fx'" "npm test(package.json scripts) 편입은 등록으로 인정"
rm -rf "$fx"

# fixture 6 (impl-fix R1): 미호출 script(test:local)에만 언급 → 등록 아님 → fail.
#   워크플로우는 `npm test` 만 호출하고 `npm run test:local` 은 없다 → test:local 값은
#   어느 run: 스텝에서도 도달 불가 → 코퍼스 제외(false-pass 차단).
fx=$(mktemp -d "${TMPDIR:-/tmp}/ci-enroll.XXXXXX")
mkdir -p "$fx/hooks/scripts/test" "$fx/.github/workflows"
: > "$fx/hooks/scripts/test/test-epsilon.sh"
printf '      - run: npm test\n' > "$fx/.github/workflows/tests.yml"
printf '{"scripts":{"test":"node --test","test:local":"bash hooks/scripts/test/test-epsilon.sh"}}\n' > "$fx/package.json"
assert_failure "bash '$GUARD' '$fx'" "미호출 script(test:local) 전용 언급은 등록 아님(도달 불가 제외)"
rm -rf "$fx"

# fixture 7 (impl-fix R1): run: 스텝이 `npm run test:local` 을 실제 호출 → 그 값은 도달 가능 → pass.
fx=$(mktemp -d "${TMPDIR:-/tmp}/ci-enroll.XXXXXX")
mkdir -p "$fx/hooks/scripts/test" "$fx/.github/workflows"
: > "$fx/hooks/scripts/test/test-zeta.sh"
printf '      - run: npm run test:local\n' > "$fx/.github/workflows/tests.yml"
printf '{"scripts":{"test":"noop","test:local":"bash hooks/scripts/test/test-zeta.sh"}}\n' > "$fx/package.json"
assert_success "bash '$GUARD' '$fx'" "run 스텝이 npm run test:local 호출 시 그 값은 도달 가능(등록 인정)"
rm -rf "$fx"

test_summary
