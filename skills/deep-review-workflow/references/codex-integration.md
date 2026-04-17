# Codex Integration Guide

## 감지 방법

환경 감지 스크립트가 다음 변수를 출력:
- `codex_plugin`: Codex Claude Code 플러그인 설치 여부 (`$HOME/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs` 탐색)
- `codex_companion_path`: companion 스크립트 절대 경로 (플러그인 미설치 시 빈 문자열)
- `codex_cli`: Codex CLI 설치 여부 (`command -v codex`)
- `codex_cli_path`: CLI 바이너리 절대 경로
- `codex_installed`: 하위호환 — `codex_plugin` OR `codex_cli`

교차 검증에는 `codex_plugin=true`가 필요. CLI만 있으면 (codex_cli=true, codex_plugin=false) 교차 검증 불가, 플러그인 설치 안내.

## Preflight

Codex 3-way 리뷰 진입 전 반드시 확인:
1. codex_plugin=true (환경 감지 스크립트 결과)
2. **가벼운 dry-run 호출로 Codex 동작 확인** — `timeout(1)` 바이너리는 macOS 기본 탑재가 아니므로 portable shim을 사용한다:

   ```bash
   _timeout() {
     sec=$1; shift
     if command -v gtimeout >/dev/null 2>&1; then gtimeout "$sec" "$@"; return; fi
     if command -v timeout  >/dev/null 2>&1; then  timeout "$sec" "$@"; return; fi
     # macOS 기본 탑재 perl fallback — alarm SIGNAL 기반
     perl -e 'alarm shift; exec @ARGV' "$sec" "$@"
   }
   ```

   **사용 패턴 (중요)**: `_timeout`은 함수이므로 **매 Bash tool 호출의 command string 안에 함께 정의**해야 한다. Claude Code의 `Bash` 호출은 각자 새로운 subshell을 열기 때문에 이전 호출에서 정의한 함수는 보이지 않는다. 표준 단편은 다음과 같이 shim 정의 + 실제 호출을 하나의 command 문자열로 묶어 전달한다:

   ```bash
   Bash({ command: '
   _timeout() {
     sec=$1; shift
     if command -v gtimeout >/dev/null 2>&1; then gtimeout "$sec" "$@"; return; fi
     if command -v timeout  >/dev/null 2>&1; then  timeout "$sec" "$@"; return; fi
     perl -e '"'"'alarm shift; exec @ARGV'"'"' "$sec" "$@"
   }
   _timeout 10 node "{codex_companion_path}" --help >/dev/null 2>&1 && echo OK || echo FAIL
   ', run_in_background: false })
   ```

   - `OK` → 정상, 3-way 리뷰 진행
   - `FAIL` → Codex를 "미수행"으로 표시하고 Opus 단독으로 즉시 fallback (silent degradation 금지)
3. **실제 리뷰 호출 timeout**: review/adversarial-review 각각 `_timeout 300` (5분) 래퍼로 감싸기.
   초과 시 해당 리뷰어는 "미수행" 처리. 모든 호출의 command string 시작부에 shim 정의를 포함한다.
4. 리포트에 각 리뷰어의 실행 상태를 명시 (`success` / `failed: <사유>` / `timeout` / `not_attempted`).
5. 3개 중 2개 실패해도 남은 1개로 합성 진행 (N-way synthesis, 아래 표 참조).

> macOS: Homebrew `coreutils`로 `gtimeout`/`timeout`을 설치하면 perl fallback 없이 동작한다. `brew install coreutils` 권장. shim이 두 케이스를 모두 처리하므로 사전 설치 여부와 무관하게 안전.
> 향후 `hooks/scripts/timeout-shim.sh` 같은 독립 파일로 분리하여 `source`하는 패턴으로 개선하면 command string이 짧아진다 (v1.4 백로그 후보).

## 3-way 병렬 리뷰

Codex가 사용 가능할 때 3개 리뷰를 **백그라운드에서 동시 실행**:

1. **Claude Opus 서브에이전트** (Agent tool, model: opus, run_in_background: true)
   - 독립 컨텍스트에서 5가지 관점 리뷰
   - 항상 실행됨

2. **codex review** (Bash tool, run_in_background: true)
   - `_timeout 300 node "{codex_companion_path}" review {codex_target_flag}` — shim 정의를 command 시작부에 포함 (Preflight 섹션 참조)
   - `{codex_target_flag}`: clean/WIP 커밋 후 → `--base {review_base}`, dirty tree → `--uncommitted`
   - Skill tool이 아닌 Bash 직접 호출 (disable-model-invocation: true)

3. **codex adversarial-review** (Bash tool, run_in_background: true)
   - **단일 Bash 호출 inline 패턴**을 사용한다. 별도 호출 분리 시 `$focus_file` 변수가 새 subshell에서 unset된다. `_timeout` shim 정의도 동일 command 문자열 안에 포함한다:

     ```
     Bash({ command: '
     _timeout() { sec=$1; shift
       if command -v gtimeout >/dev/null 2>&1; then gtimeout "$sec" "$@"; return; fi
       if command -v timeout  >/dev/null 2>&1; then  timeout "$sec" "$@"; return; fi
       perl -e '"'"'alarm shift; exec @ARGV'"'"' "$sec" "$@"
     }
     focus_file=$(mktemp "${TMPDIR:-/tmp}/deep-review-focus.XXXXXX") \
       && chmod 600 "$focus_file" \
       && cat > "$focus_file" <<FOCUS_EOF_deepreview
     {focus_text}
     FOCUS_EOF_deepreview
     _timeout 300 node "{codex_companion_path}" adversarial-review {codex_target_flag} - < "$focus_file"
     rc=$?; rm -f "$focus_file"; exit $rc
     ', run_in_background: true })
     ```

   - `{codex_target_flag}`: 위와 동일
   - focus_text는 here-doc stdin으로 전달 (쉘 명령 문자열에 삽입 금지)
   - delimiter `FOCUS_EOF_deepreview`는 focus_text에 포함되지 않는 unique 문자열 사용 (충돌 위험 시 UUID 접미사)
   - Skill tool이 아닌 Bash 직접 호출 (disable-model-invocation: true)
   - **금지**:
     - 고정 경로 `/tmp/deep-review-focus.txt` 같은 predictable name (race/symlink attack)
     - 별도 Bash 호출에 `$focus_file` 참조 (subshell 경계에서 unset)
     - 호출 1에서 `trap EXIT` 등록 후 호출 2를 background로 분리 (호출 1 종료 시 파일 선제 삭제)

## 포커스 텍스트 생성

rules.yaml과 contract에서 adversarial-review의 포커스를 자동 구성:

rules.yaml의 architecture.layers가 정의되어 있으면:
→ "레이어 경계 위반({layers 목록})과 종속성 방향을 집중 검토"

rules.yaml의 entropy 규칙이 있으면:
→ "중복 코드, ad-hoc 헬퍼, 패턴 불일치를 집중 검토"

contract criteria가 있으면:
→ "다음 성공 기준이 실제로 충족되는지 검토: {criteria 목록}"

## Fallback

Codex 플러그인 미설치 시 (codex_plugin=false):
1. **1회만** 사용자에게 안내:
   - codex_cli=false: "Codex 플러그인이 설치되어 있으면 교차 모델 검증이 가능합니다. 설치: `claude plugin add codex`"
   - codex_cli=true: "Codex CLI가 감지되었지만, 교차 모델 검증에는 Codex Claude Code 플러그인이 필요합니다. 설치: `claude plugin add codex`"
2. Claude Opus 서브에이전트 단독 리뷰로 진행
3. 알림은 리포지터리당 1회 — `.deep-review/config.yaml`의 `codex_notified` 플래그로 관리

## 합성 (Synthesis)

3개 리뷰 결과를 하나의 리포트로 합성:

| 패턴 | 확신도 | 처리 |
|------|--------|------|
| 3/3 일치 | 높음 🔴 | 자동 REQUEST_CHANGES |
| 2/3 일치 | 중간 🟡 | CONCERN (사람에게 에스컬레이션) |
| 1/3 단독 | 낮음 | 참고 사항으로 표시 |
| 0/3 | 안전 🟢 | APPROVE |

### N-way 합성 (일부 리뷰어 미수행)

리뷰어가 실패·timeout·미설치 등으로 실제 실행된 개수(N)가 3 미만일 때:

| 실제 실행 | 일치 패턴 | 처리 |
|-----------|-----------|------|
| N=2 | 2/2 일치 | 🔴 높음 → REQUEST_CHANGES |
| N=2 | 1/2 단독 | 🟡 CONCERN (에스컬레이션) |
| N=2 | 0/2 | 🟢 APPROVE |
| N=1 | 1/1 지적 | 🟡 단독 — 리포트에 "단일 리뷰어" 주의 표시 후 CONCERN |
| N=1 | 0/1 | 🟢 APPROVE (단, "단일 리뷰어"로 표기) |

리포트의 Summary에 `Review Mode: {N-way, executed=[reviewer list]}`로 실제 구성을 명시.
