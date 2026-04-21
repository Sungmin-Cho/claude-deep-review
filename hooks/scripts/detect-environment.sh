#!/usr/bin/env bash
set -euo pipefail

# === F2: Node.js 가용성 helper (모든 출력 분기에서 공유) ===
# CR7 대응: 하드코딩 금지 — 실제 PATH 에서 node 를 탐지해 값 emit.
emit_node_availability() {
  local node_available="false"
  local node_path=""
  if command -v node >/dev/null 2>&1; then
    node_available="true"
    node_path="$(command -v node)"
  fi
  echo "node_available=$node_available"
  echo "node_path=$node_path"
}

# === 1. Git 리포지터리 여부 ===
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "is_git=false"
  echo "has_commits=false"
  echo "change_state=non-git"
  echo "codex_plugin=false"
  echo "codex_companion_path="
  echo "codex_cli=false"
  echo "codex_cli_path="
  # F4 DEPRECATED: `codex_installed` 필드는 v1.4.0 에서 제거 예정.
  # 새 소비자는 `codex_plugin` 직접 사용. 현재는 하위호환을 위해 유지.
  echo "codex_installed=false"
  emit_node_availability
  exit 0
fi

echo "is_git=true"

# === 2. 커밋 존재 여부 ===

# semver 기반 최신 codex-companion.mjs 선택 (POSIX 호환, `sort -V` 미지원 환경 대응).
# awk로 zero-padded 정렬 키를 만들어 일반 `sort`로 처리 → macOS 구버전/BusyBox에서도 안정적.
#
# 한계:
# - pre-release 식별자 처리 안 됨: `1.2.0-rc.1` 과 `1.2.0` 이 같은 정렬 키(000000001.000000002.000000000)
#   를 가져 `tail -1`이 filesystem-dependent한 순서를 따른다. Codex companion이 pre-release 버전을
#   실제로 배포하면 명시적 우선순위(정식 > pre-release) 비교를 추가해야 함.
# - 구버전 BSD awk(macOS 10.14 이하)에서 `+0`이 NaN을 반환할 여지가 있음. 현재 macOS(Darwin 22+)는 OK.
select_latest_codex_script() {
  ls -d "$HOME/.claude/plugins/cache/openai-codex/codex"/*/scripts/codex-companion.mjs 2>/dev/null \
    | awk -F/ '{
        ver = ""
        for (i = 1; i <= NF; i++) { if ($i == "codex" && (i+1) <= NF) { ver = $(i+1); break } }
        n = split(ver, parts, ".")
        for (j = 1; j <= 3; j++) { if (j > n) parts[j] = 0; else parts[j] = parts[j] + 0 }
        printf "%010d.%010d.%010d\t%s\n", parts[1], parts[2], parts[3], $0
      }' \
    | sort \
    | tail -1 \
    | cut -f2-
}

if ! git rev-parse HEAD >/dev/null 2>&1; then
  echo "has_commits=false"
  echo "change_state=initial"
  codex_plugin="false"
  codex_companion_path=""
  CODEX_SCRIPT=$(select_latest_codex_script || true)
  if [ -n "$CODEX_SCRIPT" ] && [ -f "$CODEX_SCRIPT" ]; then
    codex_plugin="true"
    codex_companion_path="$CODEX_SCRIPT"
  fi
  echo "codex_plugin=$codex_plugin"
  echo "codex_companion_path=$codex_companion_path"
  codex_cli="false"
  codex_cli_path=""
  if command -v codex >/dev/null 2>&1; then
    codex_cli="true"
    codex_cli_path="$(command -v codex)"
  fi
  echo "codex_cli=$codex_cli"
  echo "codex_cli_path=$codex_cli_path"
  # F4 DEPRECATED: `codex_installed` 필드는 v1.4.0 에서 제거 예정.
  if [ "$codex_plugin" = "true" ] || [ "$codex_cli" = "true" ]; then
    echo "codex_installed=true"
  else
    echo "codex_installed=false"
  fi
  emit_node_availability
  exit 0
fi

echo "has_commits=true"

# === 3. 변경 상태 세분화 (staged/unstaged/mixed/untracked-only/clean) ===
staged=$(git diff --cached --name-only 2>/dev/null | wc -l | tr -d ' ')
unstaged=$(git diff --name-only 2>/dev/null | wc -l | tr -d ' ')
untracked=$(git ls-files --others --exclude-standard 2>/dev/null | wc -l | tr -d ' ')

echo "staged=$staged"
echo "unstaged=$unstaged"
echo "untracked=$untracked"

if [ "$staged" -eq 0 ] && [ "$unstaged" -eq 0 ] && [ "$untracked" -eq 0 ]; then
  echo "change_state=clean"
elif [ "$staged" -gt 0 ] && [ "$unstaged" -gt 0 ]; then
  echo "change_state=mixed"
elif [ "$staged" -gt 0 ]; then
  echo "change_state=staged"
elif [ "$unstaged" -gt 0 ]; then
  echo "change_state=unstaged"
else
  echo "change_state=untracked-only"
fi

# untracked 파일이 존재하면 항상 보고 (primary state와 무관하게 리뷰 대상에 포함)
if [ "$untracked" -gt 0 ]; then
  echo "has_untracked=true"
else
  echo "has_untracked=false"
fi

# === 4. review base 결정 (안전한 fallback 체인) ===
review_base=""
review_base_method=""

# 시도 1: merge-base with remote default branch
for remote_ref in "origin/HEAD" "origin/main" "origin/master"; do
  if git rev-parse --verify "$remote_ref" >/dev/null 2>&1; then
    candidate=$(git merge-base HEAD "$remote_ref" 2>/dev/null || true)
    if [ -n "$candidate" ]; then
      review_base="$candidate"
      review_base_method="merge-base"
      break
    fi
  fi
done

# 시도 2: HEAD~1 (커밋이 2개 이상일 때만)
if [ -z "$review_base" ]; then
  commit_count=$(git rev-list --count HEAD 2>/dev/null || echo "1")
  if [ "$commit_count" -gt 1 ]; then
    review_base="HEAD~1"
    review_base_method="head-parent"
  fi
fi

# 시도 3: root commit (커밋이 1개뿐) — empty tree hash 사용
if [ -z "$review_base" ]; then
  review_base="4b825dc642cb6eb9a060e54bf8d69288fbee4904"
  review_base_method="empty-tree"
fi

echo "review_base=$review_base"
echo "review_base_method=$review_base_method"

# shallow clone 여부
if [ -f "$(git rev-parse --git-dir)/shallow" ]; then
  echo "is_shallow=true"
else
  echo "is_shallow=false"
fi

# === 5. Codex 감지 (파일 시스템만, 네트워크 호출 없음) ===

# 5a. Codex 플러그인 감지 + companion 스크립트 경로
codex_plugin="false"
codex_companion_path=""
# POSIX 호환 semver 정렬 (select_latest_codex_script 함수 사용).
# 구버전 macOS/BusyBox의 `sort -V` 미지원 문제를 회피.
CODEX_SCRIPT=$(select_latest_codex_script || true)
if [ -n "$CODEX_SCRIPT" ] && [ -f "$CODEX_SCRIPT" ]; then
  codex_plugin="true"
  codex_companion_path="$CODEX_SCRIPT"
fi
echo "codex_plugin=$codex_plugin"
echo "codex_companion_path=$codex_companion_path"

# 5b. Codex CLI 감지
codex_cli="false"
codex_cli_path=""
if command -v codex >/dev/null 2>&1; then
  codex_cli="true"
  codex_cli_path="$(command -v codex)"
fi
echo "codex_cli=$codex_cli"
echo "codex_cli_path=$codex_cli_path"

# 5c. 하위호환 — F4 DEPRECATED: `codex_installed` 필드는 v1.4.0 에서 제거 예정.
# 새 소비자는 `codex_plugin` 을 직접 사용.
if [ "$codex_plugin" = "true" ] || [ "$codex_cli" = "true" ]; then
  echo "codex_installed=true"
else
  echo "codex_installed=false"
fi

# 5d. F2 — Node.js 가용성 (Codex companion 은 .mjs 이므로 node 필수)
emit_node_availability
