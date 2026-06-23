#!/usr/bin/env bash
# test-extract-anchor.sh — extract_anchor 계약 단위 테스트 (spec §5.1 / R1-F8).
set -Eeuo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=test-helpers.sh
source "$HERE/test-helpers.sh"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/extract-anchor.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

# Fixture A — 정상 1쌍.
cat > "$tmp/ok.md" <<'EOF'
intro
<!-- SSOT:foo START -->
line-1
line-2
<!-- SSOT:foo END -->
outro
EOF

# Fixture B — START 만 (END 없음).
printf 'x\n<!-- SSOT:bar START -->\nbody\n' > "$tmp/no-end.md"

# Fixture C — 중복 쌍 (같은 name 2회).
cat > "$tmp/dup.md" <<'EOF'
<!-- SSOT:baz START -->
a
<!-- SSOT:baz END -->
<!-- SSOT:baz START -->
b
<!-- SSOT:baz END -->
EOF

# Fixture D — 빈 블록.
printf '<!-- SSOT:empty START -->\n<!-- SSOT:empty END -->\n' > "$tmp/empty.md"

# Fixture E — 역순 (END 가 START 보다 앞).
cat > "$tmp/rev.md" <<'EOF'
<!-- SSOT:rv END -->
<!-- SSOT:rv START -->
EOF

# 1. 정상 추출 → 마커 제외 본문.
got="$(extract_anchor "$tmp/ok.md" foo)"
assert_equal "$(printf 'line-1\nline-2')" "$got" "extract_anchor returns inner body, markers stripped"
# 2. END 없음 → 실패.
assert_failure "extract_anchor '$tmp/no-end.md' bar" "missing END → exit 1"
# 3. 중복 쌍 → 실패.
assert_failure "extract_anchor '$tmp/dup.md' baz" "duplicate anchor pair → exit 1"
# 4. 빈 블록 → 실패.
assert_failure "extract_anchor '$tmp/empty.md' empty" "empty block → exit 1"
# 5. 역순 → 실패.
assert_failure "extract_anchor '$tmp/rev.md' rv" "END before START → exit 1"
# 6. 미존재 name → 실패.
assert_failure "extract_anchor '$tmp/ok.md' nope" "absent name → exit 1"

# --- assert_anchor_singleton: 임시 git repo fixture ---
# 파일을 UNTRACKED 로 둔다(git add 안 함) — Task 2 Step 11(커밋 전 review-execution.md)
# 시나리오를 직접 검증. --untracked 가 working-tree 를 보므로 no-commit repo 에서도 매치(실증).
gtmp="$(mktemp -d "${TMPDIR:-/tmp}/anchor-singleton.XXXXXX")"
git -C "$gtmp" init -q
printf 'x\n<!-- SSOT:uniq START -->\nbody\n<!-- SSOT:uniq END -->\n' > "$gtmp/a.md"
printf '<!-- SSOT:dup START -->\nb1\n<!-- SSOT:dup END -->\n' > "$gtmp/b.md"
printf '<!-- SSOT:dup START -->\nb2\n<!-- SSOT:dup END -->\n' > "$gtmp/c.md"   # 같은 name 2번째 파일
printf '<!-- SSOT:twice START -->\n<!-- SSOT:twice START -->\nx\n<!-- SSOT:twice END -->\n' > "$gtmp/d.md"  # in-file 중복 START
# 7. 단일 파일 1쌍(untracked) → pass.
assert_success "assert_anchor_singleton '$gtmp' uniq" "singleton: 1 START+END in 1 untracked file → pass"
# 8. 두 파일에 같은 name → fail.
assert_failure "assert_anchor_singleton '$gtmp' dup" "singleton: same name in 2 files → fail"
# 9. 같은 파일 내 START 2회 → fail.
assert_failure "assert_anchor_singleton '$gtmp' twice" "singleton: START twice in one file → fail"
# 10. 미존재 → fail.
assert_failure "assert_anchor_singleton '$gtmp' absent" "singleton: absent name → fail"
rm -rf "$gtmp"

test_summary
