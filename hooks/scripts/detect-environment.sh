#!/usr/bin/env bash
set -euo pipefail

# === 1. Git 리포지터리 여부 ===
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "is_git=false"
  echo "has_commits=false"
  echo "change_state=non-git"
  echo "codex_plugin=false"
  echo "codex_companion_path="
  echo "codex_cli=false"
  echo "codex_cli_path="
  echo "codex_installed=false"
  exit 0
fi

echo "is_git=true"

# === 2. 커밋 존재 여부 ===
if ! git rev-parse HEAD >/dev/null 2>&1; then
  echo "has_commits=false"
  echo "change_state=initial"
  codex_plugin="false"
  codex_companion_path=""
  CODEX_SCRIPT=$(ls -d "$HOME/.claude/plugins/cache/openai-codex/codex"/*/scripts/codex-companion.mjs 2>/dev/null | sort -V | tail -1 || true)
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
  if [ "$codex_plugin" = "true" ] || [ "$codex_cli" = "true" ]; then
    echo "codex_installed=true"
  else
    echo "codex_installed=false"
  fi
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
  review_base="4b825dc642cb6eb9a060e54bf899d69f7cb46617"
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
# NOTE: sort -V는 GNU 확장. macOS에서는 Homebrew coreutils 필요할 수 있음.
# 실패 시 codex_plugin=false fallback.
CODEX_SCRIPT=$(ls -d "$HOME/.claude/plugins/cache/openai-codex/codex"/*/scripts/codex-companion.mjs 2>/dev/null | sort -V | tail -1 || true)
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

# 5c. 하위호환
if [ "$codex_plugin" = "true" ] || [ "$codex_cli" = "true" ]; then
  echo "codex_installed=true"
else
  echo "codex_installed=false"
fi
