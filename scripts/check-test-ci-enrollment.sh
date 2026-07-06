#!/usr/bin/env bash
# check-test-ci-enrollment.sh — hooks/scripts/test/test-*.sh 중 어느 워크플로우
# run: 스텝에도 npm test(package.json scripts)에도 등록되지 않은 orphan 테스트를
# 검출하는 CI 게이트.
#
# 근본원인(#2): tests.yml 의 수동 열거 드리프트 — 새 테스트가 CI 스텝 추가 누락으로
# 조용히 빠진다(실례: test-extract-anchor.sh). glob 러너(npm run test:all) 전면
# 전환은 phase6 PyYAML 이중 실행 얽힘으로 기각 → 경량 meta-check 로 재발을 원천 차단.
#
# 등록 판정(plan-R1 드리프트 강화 + impl-fix R1): "실행 라인의 호출 패턴"만 인정한다.
#   - 워크플로우: run: 스텝 라인(`- run:` 결합형 포함)의 `(bash|sh) …<name>` 호출.
#   - package.json: run: 스텝에서 실제 호출되는 npm script(`npm test`→scripts.test,
#     `npm run <name>`→scripts.<name>) 값 안의 `(bash|sh) …<name>` 호출만. 어느 run:
#     스텝도 호출하지 않는 script(예: test:all/test:local) 값은 도달 불가 → 코퍼스에서
#     제외한다(미호출 script 전용 언급의 false-pass 차단).
# paths: 필터나 주석에 파일명만 언급된 것은 등록으로 인정하지 않는다(오판 차단).
#
# 제외: test-helpers.sh(sourced helper, standalone main 없음).
# ROOT 인자는 fixture 주입용(단위 테스트 test-check-test-ci-enrollment.sh).
set -Eeuo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
TEST_DIR="$ROOT/hooks/scripts/test"
WF_DIR="$ROOT/.github/workflows"
PKG="$ROOT/package.json"

# 워크플로우 run: 스텝 라인 (실행 코퍼스의 1차 소스).
wf_runs="$(grep -hE '^[[:space:]]*(-[[:space:]]+)?run:' "$WF_DIR"/*.yml 2>/dev/null || true)"

# run: 스텝에서 실제 호출되는 npm script 이름만 해석 → 도달 가능한 scripts 값만 편입.
#   `npm test`       → test        (npm 기본 alias)
#   `npm run <name>` → <name>
# 도달 불가한 script(어느 run: 도 호출 안 함) 값은 제외한다(bash 3.2 호환 grep/sed 파싱).
reachable_names="$(
  {
    printf '%s\n' "$wf_runs" | grep -Eq 'npm[[:space:]]+test([^[:alnum:]:._-]|$)' && printf 'test\n' || true
    printf '%s\n' "$wf_runs" | grep -oE 'npm[[:space:]]+run[[:space:]]+[A-Za-z0-9:._/-]+' \
      | sed -E 's/^npm[[:space:]]+run[[:space:]]+//' || true
  } | sort -u
)"

# 도달 가능한 script 이름의 값만 출력(이름 목록을 stdin 으로 전달).
reachable_values="$(
  printf '%s\n' "$reachable_names" | python3 -c 'import json, sys
names = {ln.strip() for ln in sys.stdin if ln.strip()}
try:
    scripts = json.load(open(sys.argv[1])).get("scripts", {})
except Exception:
    scripts = {}
for name in names:
    if name in scripts:
        print(scripts[name])' "$PKG" 2>/dev/null || true
)"

# 실행 코퍼스 = 워크플로우 run: 스텝 라인 + run: 에서 도달 가능한 npm scripts 값.
corpus="$(printf '%s\n%s\n' "$wf_runs" "$reachable_values")"

missing=()
for t in "$TEST_DIR"/test-*.sh; do
  [ -e "$t" ] || continue          # empty-glob 가드(테스트 파일 없음)
  base="$(basename "$t")"
  case "$base" in
    test-helpers.sh) continue ;;   # sourced helper, standalone main 없음(의도적 제외)
  esac
  # 호출 패턴 `(bash|sh) …<name>` 만 등록으로 인정 — paths: 필터/주석의 bare
  # 파일명 언급은 불인정. 파일명의 `.` 는 정규식 any-char 오탐 방지 위해 이스케이프.
  base_re="${base//./\\.}"
  printf '%s\n' "$corpus" | grep -Eq "(bash|sh)[[:space:]]+[^[:space:]]*${base_re}" \
    || missing+=("$base")
done

if [ "${#missing[@]}" -gt 0 ]; then
  echo "❌ CI 미등록 테스트(어느 워크플로우 run: 스텝/npm test 에도 없음):" >&2
  printf '   - %s\n' "${missing[@]}" >&2
  echo "   → .github/workflows/tests.yml 에 스텝을 추가하거나 npm test 에 편입하세요." >&2
  exit 1
fi
echo "✅ 모든 hooks/scripts/test/test-*.sh 가 CI 에 등록됨"
