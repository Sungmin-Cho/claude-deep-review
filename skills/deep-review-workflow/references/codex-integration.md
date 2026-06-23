# Codex Integration Guide

> Related: [`agy-integration.md`](./agy-integration.md) — fourth reviewer (Google Gemini), orthogonal to mutation protocol.

## 감지 방법

환경 감지 스크립트가 다음 변수를 출력:
- `codex_plugin`: Codex Claude Code 플러그인 설치 여부 (`$HOME/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs` 탐색). **CR5**: marketplace 는 `openai-codex` 로 고정 — 임의 marketplace 완화는 supply-chain 리스크로 backlog.
- `codex_companion_path`: companion 스크립트 절대 경로 (플러그인 미설치 시 빈 문자열)
- `codex_cli`: Codex CLI 설치 여부 (`command -v codex`)
- `codex_cli_path`: CLI 바이너리 절대 경로
- `node_available`: Node.js 실행 가능 여부 (`command -v node`) **[v1.3.2 F2 신규]**
- `node_path`: node 바이너리 절대 경로
- `claude_cli`: Claude CLI 설치 여부 (`command -v claude`). Codex/non-Claude 런타임에서 Claude reviewer bridge를 실행할 때 필요.
- `claude_cli_path`: Claude CLI 바이너리 절대 경로
- `codex_installed`: 하위호환 — `codex_plugin` OR `codex_cli`. **[DEPRECATED — v1.4.0 에서 제거 예정, 새 소비자는 `codex_plugin` 직접 사용]**

교차 검증에는 `codex_plugin=true`가 필요. CLI만 있으면 (codex_cli=true, codex_plugin=false) 교차 검증 불가, 플러그인 설치 안내.

**F2 노드 체크**: `codex_plugin=true AND node_available=false` 조합 → 사용자 안내: "Codex companion 은 감지되었으나 Node.js 가 PATH 에 없어 호출 불가. `brew install node` 등으로 설치 필요." 이후 Opus 단독 fallback.

## Preflight

Codex 3-way 리뷰 진입 전 반드시 확인:
1. codex_plugin=true (환경 감지 스크립트 결과)
2. **가벼운 dry-run 호출로 Codex 동작 확인** — `timeout(1)` 바이너리는 macOS 기본 탑재가 아니므로 portable shim을 사용한다:

   ```bash
   _timeout() {
     sec=$1; shift
     if command -v gtimeout >/dev/null 2>&1; then gtimeout "$sec" "$@"; return; fi
     if command -v timeout  >/dev/null 2>&1; then  timeout "$sec" "$@"; return; fi
     # BLOCKER-1/N3 fix: shift $seconds before fork so child's @ARGV is the actual command.
     perl -e '
       my $seconds = shift @ARGV;
       my $pid = fork;
       if (!defined $pid) { die "fork: $!" }
       if (!$pid) { exec @ARGV; die "exec: $!" }
       alarm $seconds;
       $SIG{ALRM} = sub { kill 15, $pid; exit 124 };
       wait;
       exit ($? >> 8)
     ' "$sec" "$@"
   }
   ```

   **사용 패턴 (중요)**: `_timeout`은 함수이므로 **매 Bash tool 호출의 command string 안에 함께 정의**해야 한다. Claude Code의 `Bash` 호출은 각자 새로운 subshell을 열기 때문에 이전 호출에서 정의한 함수는 보이지 않는다. 표준 단편은 다음과 같이 shim 정의 + 실제 호출을 하나의 command 문자열로 묶어 전달한다:

   ```bash
   Bash({ command: '
   _timeout() {
     sec=$1; shift
     if command -v gtimeout >/dev/null 2>&1; then gtimeout "$sec" "$@"; return; fi
     if command -v timeout  >/dev/null 2>&1; then  timeout "$sec" "$@"; return; fi
     perl -e '"'"'
       my $seconds = shift @ARGV;
       my $pid = fork;
       if (!defined $pid) { die "fork: $!" }
       if (!$pid) { exec @ARGV; die "exec: $!" }
       alarm $seconds;
       $SIG{ALRM} = sub { kill 15, $pid; exit 124 };
       wait;
       exit ($? >> 8)
     '"'"' "$sec" "$@"
   }
   _timeout 10 node "{codex_companion_path}" --help >/dev/null 2>&1 && echo OK || echo FAIL
   ', run_in_background: false })
   ```

   - `OK` → 정상, 3-way 리뷰 진행
   - `FAIL` → Codex를 "미수행"으로 표시하고 Opus 단독으로 즉시 fallback (silent degradation 금지)
3. **실제 리뷰 호출 timeout**: review/adversarial-review 각각 `_timeout 900` (15분) 래퍼로 감싸기. v1.5.0+ 에서 기존 300s 가 대형 diff·rate-limit·재시도 상황에서 자주 미달되어 900s 로 상향. 초과 시 해당 리뷰어는 "미수행" 처리. 모든 호출의 command string 시작부에 shim 정의를 포함한다.
4. 리포트에 각 리뷰어의 실행 상태를 명시 (`success` / `failed: <사유>` / `timeout` / `not_attempted`).
5. 3개 중 2개 실패해도 남은 1개로 합성 진행 (N-way synthesis, 아래 표 참조).

> macOS: Homebrew `coreutils`로 `gtimeout`/`timeout`을 설치하면 perl fallback 없이 동작한다. `brew install coreutils` 권장. shim이 두 케이스를 모두 처리하므로 사전 설치 여부와 무관하게 안전.
> 향후 `hooks/scripts/timeout-shim.sh` 같은 독립 파일로 분리하여 `source`하는 패턴으로 개선하면 command string이 짧아진다 (v1.3.2 백로그 후보 — `docs/backlog-2026-04-17.md` 항목 2).

## 3-way 병렬 리뷰

Codex가 사용 가능할 때 3개 리뷰를 **백그라운드에서 동시 실행**:

1. **Claude Opus reviewer**
   - 독립 컨텍스트에서 6가지 관점 리뷰
   - 항상 실행됨
   - Claude Code 런타임: Agent tool (`code-reviewer`, model: opus, run_in_background: true)
   - Codex / non-Claude 런타임: Agent tool이 없으므로 `hooks/scripts/run-claude-reviewer.sh`를 Bash로 실행. helper는 동일 prompt를 받아 `claude -p --plugin-dir "{CLAUDE_PLUGIN_ROOT}" --agent code-reviewer --model opus`를 호출한다.
   - Codex의 `spawn_agent`로 대체 금지. 이는 Claude reviewer가 아니라 Codex reviewer라서 Opus + Codex review + Codex adversarial 3-way 계약을 깨뜨린다.
   - `claude_cli=false` 또는 helper exit 127이면 Claude reviewer는 `not_attempted: claude_cli_unavailable`로 표시하고 N-way synthesis로 진행.

   > **공유 PROMPT_FILE 소비 (필수)**: 이 claude bridge 의 `--prompt-file` 은 새 `mktemp` 가 아니라
   > `review-execution.md` 의 "공유 reviewer payload 조립" 블록이 캡처한 **`PROMPT_FILE` 리터럴 경로
   > 바로 그것**이다 — fp-doctrine + change_files manifest 가 이미 담긴, single-opus(Agent tool 입력)·
   > ultracode 6 샤드·agy 가 소비하는 **동일한 하나의 파일**. claude bridge 전용으로 별도 prompt 를 다시
   > 조립하면 그 payload(독트린/change_files)를 잃어 v1.12.0 #2(독트린·변경셋이 모든 리뷰어에 도달)를
   > 깨뜨린다. `run-claude-reviewer.sh` 는 `--prompt-file` 을 필수로 요구하므로 캡처한 리터럴을 그대로 넘긴다.
   > 정본 호출 형태는 `review-execution.md` 의 `SSOT:claude-bridge-call` 앵커 참조.

   ```bash
   output_file=$(mktemp "${TMPDIR:-/tmp}/deep-review-claude-output.XXXXXX")
   "{CLAUDE_PLUGIN_ROOT}/hooks/scripts/run-claude-reviewer.sh" \
     --project-root "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" \
     --plugin-root "{CLAUDE_PLUGIN_ROOT}" \
     --prompt-file '<captured PROMPT_FILE literal>' \
     --output "$output_file" \
     --model "opus"
   ```

2. **codex review** (Bash tool, run_in_background: true)
   - `_timeout 900 node "{codex_companion_path}" review {codex_target_flag}` — shim 정의를 command 시작부에 포함 (Preflight 섹션 참조)
   - `{codex_target_flag}`: clean/WIP 커밋 후 → `--base {review_base}`, dirty tree → `--scope working-tree` (v1.3.2 F8: `--uncommitted` 는 companion 1.0.x 미지원)
   - Skill tool이 아닌 Bash 직접 호출 (disable-model-invocation: true)

3. **codex adversarial-review** (Bash tool, run_in_background: true)
   - **단일 Bash 호출 inline 패턴**을 사용한다. 별도 호출 분리 시 `$focus_file` 변수가 새 subshell에서 unset된다. `_timeout` shim 정의도 동일 command 문자열 안에 포함한다:

     ```
     Bash({ command: '
     _timeout() { sec=$1; shift
       if command -v gtimeout >/dev/null 2>&1; then gtimeout "$sec" "$@"; return; fi
       if command -v timeout  >/dev/null 2>&1; then  timeout "$sec" "$@"; return; fi
       perl -e '"'"'
         my $seconds = shift @ARGV;
         my $pid = fork;
         if (!defined $pid) { die "fork: $!" }
         if (!$pid) { exec @ARGV; die "exec: $!" }
         alarm $seconds;
         $SIG{ALRM} = sub { kill 15, $pid; exit 124 };
         wait;
         exit ($? >> 8)
       '"'"' "$sec" "$@"
     }
     focus_file=$(mktemp "${TMPDIR:-/tmp}/deep-review-focus.XXXXXX") \
       && chmod 600 "$focus_file" \
       && cat > "$focus_file" <<FOCUS_EOF_deepreview
     {focus_text}
     FOCUS_EOF_deepreview
     _timeout 900 node "{codex_companion_path}" adversarial-review {codex_target_flag} - < "$focus_file"
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

## Codex 인증 실패 처리 (F3 — v1.3.2 신규)

Codex companion 은 인증 상태를 review 호출 시에만 검증하므로, deep-review 는 호출 stderr 을 캡처해 사용자에게 명확히 안내:

```bash
stderr_log=$(mktemp "${TMPDIR:-/tmp}/deep-review-codex-stderr.XXXXXX")
_timeout 900 node "{codex_companion_path}" review --scope working-tree 2> >(tee "$stderr_log" >&2)
rc=$?
if grep -qE 'not authenticated|Codex CLI is not authenticated|Run.*codex login' "$stderr_log"; then
  CODEX_STATUS="not_authenticated"
elif [ $rc -eq 124 ]; then
  CODEX_STATUS="timeout"
elif [ $rc -ne 0 ]; then
  CODEX_STATUS="failed"
else
  CODEX_STATUS="success"
fi
rm -f "$stderr_log"
```

- `CODEX_STATUS=not_authenticated` 시 사용자 안내: "Codex 인증이 필요합니다. 터미널에서 `!codex login` 실행 후 재시도하세요."
- 리포트 Summary 필드: `codex: ${CODEX_STATUS}` (기존 `success/failed/timeout/not_attempted` 에 `not_authenticated` 추가).
- 전체 파이프라인은 1-way Opus 단독으로 fallback.

## Mutation Protocol 참조 (v1.3.2 신규)

Case 3 에서 gitignored 세션 파일을 Codex 에 임시 노출하여 3-way 검증을 수행하는 프로토콜. 구현은 `hooks/scripts/mutation-protocol.sh` 에 캡슐화되어 있으며, `review-execution.md` 의 Stage 0.1, 2.1/2.2, 3.0, 5.0 에서 호출. 상세 설계는 `docs/superpowers/specs/2026-04-21-codex-git-mutation-protocol-design.md` (로컬, gitignored).

### Mutation gating: codex-only

agy reviewer uses `--add-dir` filesystem walk for its file context and is **not** subject to mutation protocol. The trigger condition remains `codex_plugin=true AND is_git=true` — agy presence does not affect this. See [`agy-integration.md`](./agy-integration.md) for agy's trust-boundary mitigation (fingerprint-based pre-spawn scan).

## Fallback

Codex 플러그인 미설치 시 (codex_plugin=false):
1. **1회만** 사용자에게 안내:
   - codex_cli=false: "Codex 플러그인이 설치되어 있으면 교차 모델 검증이 가능합니다. 설치: `claude plugin add codex`"
   - codex_cli=true: "Codex CLI가 감지되었지만, 교차 모델 검증에는 Codex Claude Code 플러그인이 필요합니다. 설치: `claude plugin add codex`"
2. Claude Opus 서브에이전트 단독 리뷰로 진행
3. 알림은 리포지터리당 1회 — `.deep-review/config.yaml`의 `codex_notified` 플래그로 관리

## 합성 (Synthesis)

3개 리뷰 결과를 하나의 리포트로 합성 (최대 4-way — agy 설치 시):

| 패턴 | 확신도 | 처리 |
|------|--------|------|
| 3/3 일치 | 높음 🔴 | 자동 REQUEST_CHANGES |
| 2/3 일치 | 중간 🟡 | CONCERN (사람에게 에스컬레이션) |
| 1/3 단독 | 낮음 | 참고 사항으로 표시 |
| 0/3 | 안전 🟢 | APPROVE |

### N-way 합성 (4-way pipeline 포함)

`agy` 가 추가된 후 N=4 케이스:

| N_actual | 패턴 | 처리 | Per-finding annotation |
|---|---|---|---|
| 4 | 4/4 일치 | 🔴 high → REQUEST_CHANGES | `agreement: unanimous_4` |
| 4 | 3/4 일치 | 🔴 high | `agreement: majority_3_of_4` + `dissenter` / `dissenter_family` / `dissent_summary` |
| 4 | 2/4 일치 | 🟡 CONCERN | `agreement: split_2_of_4` |
| 4 | 1/4 단독 | 참고 | `agreement: solo_1_of_4` + `source` |
| 4 | 0/4 | 🟢 APPROVE | n/a |

기존 N=3, 2, 1 fallback 행은 그대로 유지 (3-way 이하 케이스).

**Dissenter visibility rationale**: 4-way 의 핵심 가치는 cross-vendor-family bias elimination. 3/4 majority 임계값을 그대로 두되 dissenter 가 cross-family (예: agy 가 유일한 Google 가족) 라면 그 정보를 report 에 보존 → 사용자가 cross-vendor signal 강도를 판단 가능.

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

> **ultracode (v1.10.0)**: `--ultracode` 시 "Claude (Opus)" 한 칸은 6차원 fan-out 의 **단일 "Claude(ultracode)" 보이스**가 채운다(Anthropic 한 표 유지 — 샤드 개별 투표 아님). collapse 키/verify 정책 등 메커니즘은 [`ultracode-integration.md`](./ultracode-integration.md) 가 단일 출처다(여기서 재서술하지 않음).
