---
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent, Skill, AskUserQuestion
description: 현재 변경사항을 독립 에이전트로 리뷰합니다. init으로 규칙 초기화, --contract로 Sprint Contract 기반 검증, --entropy로 엔트로피 스캔, --respond로 리뷰 피드백 대응.
argument-hint: "[init] [--contract [SLICE-NNN]] [--entropy] [--respond (REPORT_PATH | --source=pr [--pr=NNN])]"
---

# /deep-review — Independent Code Review

현재 코드 변경사항을 독립된 Evaluator 에이전트로 리뷰합니다.

## Argument Dispatch

- `init` → "init 모드" 섹션으로 분기 (프로젝트별 규칙 초기화)
- `--respond` → "대응 모드" 섹션으로 분기 (리뷰 피드백 대응)
- `--qa` → 안내 메시지 후 즉시 종료:
  "App QA(`--qa`)는 향후 릴리스에서 지원 예정입니다. 현재 `.deep-review/config.yaml`의 `app_qa.*` 필드는 예약 스키마로만 유지되며 동작하지 않습니다."
- `--contract` / `--entropy` / 인수 없음 → "리뷰 모드"로 진행

## Prerequisites

`deep-review-workflow` 스킬을 다음 순서로 로드한다 (`user-invocable: false` fallback):

1. `Skill({ skill: "deep-review:deep-review-workflow" })`
2. 실패 시 `Skill({ skill: "deep-review-workflow" })`
3. 위 둘 다 실패 시 `Read({ file_path: "${CLAUDE_PLUGIN_ROOT}/skills/deep-review-workflow/SKILL.md" })` + references 폴더 내 파일들 Read fallback.

## 0. Auto-create .deep-review/ (리뷰 모드, 최초 실행 시)

`.deep-review/` 디렉토리가 없으면 **자동 생성** (init 실행 없이도 동작 보장):
```bash
mkdir -p .deep-review/contracts .deep-review/reports .deep-review/journeys
```
config.yaml이 없으면 기본값으로 생성:
```yaml
review_model: opus
codex_notified: false
last_review: null
app_qa:
  last_command: null
  last_url: null
```
rules.yaml은 생성하지 않음 (없으면 범용 기본 관점으로 리뷰).

### 0.1 자동 복원 (stale mutation recovery)

`/deep-review` 및 `/deep-review --respond` 진입 시 이전 세션에서 복원되지 않은 git index mutation 을 자동 정리 (spec §6.4):

```bash
source ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/mutation-protocol.sh
auto_recover
```

- 진행 중인 다른 세션의 lock (`.deep-review/.mutation.lock`) 을 존중 — active lock 감지 시 복원 skip + warning, 본 세션은 mutation 없이 계속 진행.
- `restore_attempts` 카운터가 3 이상이면 사용자 에스컬레이션.
- `--respond` 모드에서도 동일하게 호출 — stale mutation 이 다음 리뷰로 새어나가지 않도록.
- 상세는 `skills/deep-review-workflow/references/codex-integration.md` 참조.

## Steps (리뷰 모드)

### 1. 환경 감지

```bash
bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/detect-environment.sh
```

결과를 key=value 형식으로 파싱하여 환경 상태를 파악합니다.

**shallow clone (is_shallow=true) 감지 시:**
- "shallow clone에서는 review base가 부정확할 수 있습니다. `git fetch --unshallow`를 권장합니다." 안내
- HEAD~1 fallback으로 진행

### 2. 변경사항 수집 (Stage 1: Collect)

환경에 따라 diff를 수집합니다:

**non-git 환경 (change_state=non-git):**
- AskUserQuestion: "어떤 파일을 리뷰할까요?"
- 지정된 파일들의 전체 내용을 수집

**git + 커밋 0건 (change_state=initial):**
- 모든 파일 대상 리뷰 (empty tree hash 기준)

**git + clean (change_state=clean):**
- `git diff {review_base}..HEAD`로 최근 변경 수집

**git + staged/unstaged/mixed:**
- 해당 상태에 맞는 diff 수집 (staged: `--cached`, unstaged: `git diff`, mixed: `git diff HEAD`)
- WIP 커밋 제안 전에 포함될 파일 목록과 민감 파일 경고를 먼저 보여줌:

  1. `Bash({ command: "git status --short" })`로 대상 파일 목록을 사용자에게 표시
  2. 민감 파일 패턴(`.env*`, `**/credentials*`, `**/*secret*`, `**/*.key`, `**/*.pem`) 탐지 시 **강한 경고**:
     "다음 파일이 WIP 커밋 대상에 포함됩니다 — 민감 정보가 들어있다면 즉시 중단하세요: {파일 목록}. 계속 진행하시겠습니까?"
     (staged/unstaged/untracked 어느 상태든 경고는 동일하게 적용)
  3. AskUserQuestion: "Codex 교차 검증을 위해 WIP 커밋을 생성할까요?"
     - 옵션 A (수락 — tracked만): `git add -u && git commit -m "wip: deep-review checkpoint"`
       (tracked 파일의 수정분만 커밋. untracked 파일은 포함하지 않음)
     - 옵션 B (수락 — 전체): untracked 파일까지 포함하려는 경우, 먼저 파일 목록을 다시 확인시킨 뒤
       `git add <explicit files> && git commit -m "wip: deep-review checkpoint"` 로 명시적 add
     - 옵션 C (거부): diff 기반으로 진행 (Claude Opus + 가능하면 Codex도)
  4. 수락 시 안내: "리뷰 완료 후 `git reset --soft HEAD~1`로 WIP 커밋을 해제할 수 있습니다."
  5. `git add -A`는 사용하지 않음 — 민감 파일 무분별 스테이징을 방지.

**git + untracked-only:**
- `git ls-files --others --exclude-standard`로 파일 목록 수집 후 내용 읽기

**모든 git 상태에서 untracked > 0이면:**
- `git ls-files --others --exclude-standard`로 추가 파일을 리뷰 대상에 포함

diff에서 제외: 바이너리, vendor/, node_modules/, *.min.js, *.generated.*, *.lock

### 2.1 세션 컨텍스트 기반 대상 확장 (Case 3 전용)

`codex_plugin=true AND is_git=true` 인 경우, 기존 수집으로 산출된 `opus_target_git` 을 아래 절차로 확장 (spec §3.1):

1. Claude 가 현재 세션의 tool_use 이력을 반추하여 **Edit / Write tool 의 file_path 인자**를 수집. **Read 와 Bash 는 제외** (엄격 규칙 — Read 는 참조 용도 불확실, Bash 는 heuristic 신뢰 불가).
2. 각 후보 파일에 대해 `git check-ignore --quiet <file>` 실행.
3. exit 0 (gitignored) 인 후보만 `session_inferred_ignored` 에 추가. 단 다음 경로는 제외:
   - 의존성·빌드: `node_modules/`, `dist/`, `build/`, `.next/`, `target/`, `.venv/`, `__pycache__/`, `.pytest_cache/`, `vendor/`
   - 자기 출력: `.deep-review/reports/`, `.deep-review/responses/`, `.deep-review/entropy-log.jsonl`, `.deep-review/recurring-findings.json`, `.deep-review/.pending-mutation.json`
   - 시스템/메타: `.git/`, `.DS_Store`, `**/*.lock`, `*.min.js`, `*.generated.*`
4. `opus_target_files = opus_target_git ∪ session_inferred_ignored`

**알려진 제한**: submodule 경계는 본 PR 에서 미지원 (backlog). `git check-ignore` 는 superproject `.gitignore` 만 참조.

### 2.2 갭 감지 (Case 3 전용)

```
codex_visible = (git diff --name-only) ∪ (git diff --name-only --cached) ∪ (git ls-files --others --exclude-standard)
codex_invisible = opus_target_files - codex_visible
```

현실적으로 `codex_invisible ≡ session_inferred_ignored` (§3.2 참조). 공집합이면 현행 흐름 그대로, 비어있지 않으면 §3.0 mutation UX 로 진입.

### 3. Contract 로드 (Stage 2: Contract Check)

`--contract` 플래그 처리:
- `--contract SLICE-{NNN}` (슬라이스 지정): `.deep-review/contracts/SLICE-{NNN}.yaml`만 로드
- `--contract` (슬라이스 미지정): `.deep-review/contracts/` 내 모든 `status: active` contract 로드하여 전체 검증
- 플래그 없이 `.deep-review/contracts/`에 active contract가 있으면: 자동으로 전체 contract 검증
- contract 디렉토리가 없거나 파일이 없으면: 이 단계 건너뜀

**Contract 유효성 검증:**

LLM 수동 파싱 대신 `python3`의 `yaml.safe_load`를 Bash로 호출해 구조적으로 검증한다 (anchor/alias/indentation trick에 취약한 문자열 파싱을 피하기 위함).

```bash
python3 - "$contract_file" <<'PY'
import json, sys
try:
    import yaml
except ImportError:
    # PyYAML이 표준 라이브러리에 없어 stock python3에서 자주 missing.
    # 이 경우 호출 측이 LLM 문자열 파싱 fallback을 사용하도록 신호 전달.
    print(json.dumps({"ok": False, "error": "pyyaml-missing", "fallback": "llm-parse"}))
    sys.exit(0)
try:
    with open(sys.argv[1]) as f:
        data = yaml.safe_load(f) or {}
except yaml.YAMLError as e:
    print(json.dumps({"ok": False, "error": f"yaml parse: {e}"}))
    sys.exit(0)
required = ["slice", "title", "criteria"]
missing = [k for k in required if k not in data]
if missing:
    print(json.dumps({"ok": False, "error": f"missing fields: {missing}"}))
    sys.exit(0)
print(json.dumps({"ok": True, "data": data}))
PY
```

결과 JSON의 `ok` 처리 규칙:
- `ok: true` → `data`를 contract로 채용.
- `ok: false` + `error: "pyyaml-missing"` → PyYAML 미설치 신호. **fatal이 아님**. LLM이 문자열 파싱으로 해당 contract를 로드하고 세션에서 1회만 안내: "`pip install pyyaml` 권장 — 그 전까지는 LLM 파싱 fallback 사용."
- `ok: false` + 기타 `error` → 해당 contract는 skip + "Contract {파일명} 파싱 실패 — 건너뜀: {error}" 경고 출력.

추가 규칙:
- `python3`가 PATH에 없으면(드물지만) 동일 fallback (LLM 문자열 파싱) + 1회 안내.
- `status: archived` contract는 자동 로드에서 제외.
- `--contract SLICE-NNN`으로 archived contract를 명시적으로 지정한 경우: "SLICE-{NNN}은 archived 상태입니다. 리뷰를 계속할까요?" 확인.
- `criteria`가 비어있으면: contract 검증 건너뜀 (Stage 3만 실행).

### 4. 리뷰 실행 (Stage 3: Deep Review)

**fitness.json 주입 (있으면):**
- `.deep-review/fitness.json` 파일 확인 → `JSON.parse`로 로드
- 있으면: code-reviewer 에이전트 prompt에 추가:
  "다음은 프로젝트의 계산적 아키텍처 규칙(fitness.json)입니다. 이 규칙들은 deep-work에서 자동 검증되지만, 리뷰 시 규칙의 의도를 기준으로 설계 방향성을 평가하세요."
- 없으면: skip (에러 아님)

**Receipt health_report 주입 (있으면):**
- Receipt 발견 계약:
  1. `.deep-work/sessions/` 디렉토리에서 가장 최근 세션의 receipt.json 탐색
  2. receipt의 `health_report.scan_commit`과 현재 `git rev-parse HEAD` 비교
  3. 일치 → health_report를 code-reviewer prompt에 추가
  4. 불일치 → "stale health report — skip" 경고 + 주입하지 않음
  5. receipt 없음 → skip (에러 아님)

**유저 고지 (리뷰어 spawn 직전):**

리뷰어를 spawn하기 직전, 실행되는 리뷰어 구성에 따라 고지:
- Opus 단독 (Case 1/2): "Opus 리뷰를 백그라운드에서 실행합니다. 완료되면 결과를 알려드리겠습니다."
- 3-way (Case 3): "3개 리뷰어(Opus, Codex review, Codex adversarial)를 백그라운드에서 실행합니다. 완료되면 결과를 합성하여 알려드리겠습니다."

**Claude Opus 서브에이전트 (항상 실행):**

Agent tool로 `code-reviewer` 에이전트를 백그라운드에서 spawn합니다:
- `model: "opus"` (config.yaml의 review_model로 오버라이드 가능)
- `run_in_background: true`
- prompt에 포함: diff 내용, rules.yaml (있으면), fitness.json (있으면), health_report (있으면), contract (있으면)

**Codex preflight (codex_plugin=true일 때):**
1. `codex_plugin=true AND node_available=false` 조합 → 사용자 안내: "Codex companion 은 감지되었으나 Node.js 가 PATH 에 없어 호출 불가. `brew install node` 등으로 설치 필요." 이후 Opus 단독 진행.
2. codex:review를 시도하기 전에 Codex가 실제로 동작하는지 확인
3. 실패 시 (인증 오류, 타임아웃 등): Codex 결과를 "미수행"으로 표시하고 Claude Opus 단독으로 fallback
4. 합성 시 미수행 리뷰어는 제외 (3-way가 아닌 실제 수행된 리뷰어 수 기준)

**Stage 3.0: Mutation 허가 플로우 (codex_invisible 감지 시)**

§2.2 에서 `codex_invisible` 이 비어있지 않으면 아래 절차 수행:

1. **민감 파일 사전 스캔** (§4.1 패턴, case-insensitive):
   ```bash
   source ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/mutation-protocol.sh
   sensitive=$(scan_sensitive_files "${codex_invisible[@]}")
   ```
2. **전원 민감 파일 → 자동 skip**: `sensitive` 와 `codex_invisible` 가 동일 집합이면 프롬프트 없이 Codex skip + Summary 에 `Review Mode: 1-way (Opus only) — {N} sensitive codex-invisible file(s) auto-skipped` 기록.
3. **그 외 → AskUserQuestion 프롬프트 (단일 Y/N)**:
   - 민감 파일 감지 시 ⚠️ 블록 상단 배치.
   - 파일 목록 최대 20개 표시 + "…외 K개" 축약.
   - 실행될 git 명령 명시 (lock → precondition → add -f -N → codex 3-way → restore + lock 해제).
   - [Y] → 아래 4단계 진행, [N] → Codex skip + Summary 에 `user declined exposure` 기록.
4. **[Y] 시 mutation 수행 (graceful fallback 포함, CR3)**:
   ```bash
   if perform_mutation "${codex_invisible[@]}"; then
     MUTATION_OK=1
   else
     echo "⚠️ Codex 노출 mutation 실패 — Opus 단독 (1-way) 로 진행합니다."
     MUTATION_OK=0
   fi
   ```
   - `MUTATION_OK=1` → Codex review / adversarial 경로 진행.
   - `MUTATION_OK=0` → Codex 호출 skip, Opus 만 spawn. Summary: `Review Mode: 1-way (Opus only) — mutation failed`.

**F3 — Codex 인증 실패 구분 (stderr 캡처)**:

각 Codex 호출 Bash 블록에 stderr 캡처 + 패턴 매칭 추가:
```bash
stderr_log=$(mktemp "${TMPDIR:-/tmp}/deep-review-codex-stderr.XXXXXX")
_timeout 300 node "{codex_companion_path}" review --scope working-tree 2> >(tee "$stderr_log" >&2)
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
`CODEX_STATUS=not_authenticated` 시 사용자에게: "Codex 인증이 필요합니다. 터미널에서 `!codex login` 실행 후 재시도하세요." 리포트 Summary 에 `codex: ${CODEX_STATUS}` 기록. 1-way fallback 진행.

**Codex 교차 검증 (git + codex_plugin=true 시):**

Codex 리뷰 대상은 change_state에 따라 결정:
- `clean` → `--base {review_base}` (커밋 기준 브랜치 diff)
- `staged`/`unstaged`/`mixed`/`untracked-only` → `--scope working-tree` (작업 트리 변경사항)
  - WIP 커밋을 수락한 경우 → `--base {review_base}` (커밋 기준)

이렇게 해야 Opus(diff 기반)와 Codex가 같은 대상을 리뷰한다.

병렬 백그라운드 실행 (Bash tool 직접 호출):

> **중요 — shim inline 원칙**: `_timeout`은 bash 함수이므로 각 Bash 호출의 command 문자열에 **정의 + 사용을 한 번에** 포함해야 한다. 별도 Bash 호출에서 정의된 함수는 새 subshell에서 보이지 않는다. 상세는 `skills/deep-review-workflow/references/codex-integration.md` Preflight 섹션 참조. 아래 예제들은 shim 정의를 묵시적으로 전제하므로 실제 호출 시 함수 본문을 command 시작부에 붙여라.

- review 호출:

  ```
  Bash({ command: '
  _timeout() { sec=$1; shift
    if command -v gtimeout >/dev/null 2>&1; then gtimeout "$sec" "$@"; return; fi
    if command -v timeout  >/dev/null 2>&1; then  timeout "$sec" "$@"; return; fi
    perl -e '"'"'alarm shift; exec @ARGV'"'"' "$sec" "$@"
  }
  _timeout 300 node "{codex_companion_path}" review {codex_target_flag}
  ', run_in_background: true })
  ```
- adversarial-review (focus_text는 stdin으로 전달하여 쉘 인젝션 방지):

  **권장 (Option A — 단일 Bash 호출에 inline)**: mktemp/write/실행/정리를 한 쉘 세션에서 모두 처리. 이렇게 해야 `$focus_file` 변수가 같은 subshell 내부에서만 유효하므로 rival Bash 호출에서 unset되는 문제가 발생하지 않는다.

  ```
  Bash({ command: '
  # _timeout shim — 각 Bash 호출 subshell에 정의해야 함 (review 예제 상단 참조)
  _timeout() { sec=$1; shift
    if command -v gtimeout >/dev/null 2>&1; then gtimeout "$sec" "$@"; return; fi
    if command -v timeout  >/dev/null 2>&1; then  timeout "$sec" "$@"; return; fi
    perl -e '"'"'alarm shift; exec @ARGV'"'"' "$sec" "$@"
  }
  focus_file=$(mktemp "${TMPDIR:-/tmp}/deep-review-focus.XXXXXX") \
    && chmod 600 "$focus_file" \
    && cat > "$focus_file" <<'"'"'FOCUS_EOF_deepreview'"'"'
  {focus_text}
  FOCUS_EOF_deepreview
  _timeout 300 node "{codex_companion_path}" adversarial-review {codex_target_flag} - < "$focus_file"
  rc=$?; rm -f "$focus_file"; exit $rc
  ', run_in_background: true })
  ```

  here-doc delimiter `FOCUS_EOF_deepreview` 는 focus_text 본문에 포함되지 않도록 충분히 unique하게 선택한다. focus_text 안에 해당 문자열이 있을 가능성이 있으면 UUID/해시를 붙여 동적으로 생성한다.

  **대안 (Option B — 리터럴 경로 캡처)**: 한 Bash 호출에서 mktemp 후 stdout으로 경로를 출력하고, LLM이 그 경로를 리터럴 문자열로 받아 후속 `Write` / `Bash` 호출에 붙여 넣는다. 변수 전개를 사용하지 않으므로 안전하지만, 호출 체인이 길다.

  1. `Bash({ command: 'f=$(mktemp "${TMPDIR:-/tmp}/deep-review-focus.XXXXXX") && chmod 600 "$f" && echo "$f"' })` → stdout에서 리터럴 경로 `<PATH>` 획득
  2. `Write({ file_path: "<PATH>", content: focus_text })`  (변수 아님, 실제 경로)
  3. `Bash({ command: '_timeout 300 node "{codex_companion_path}" adversarial-review {codex_target_flag} - < "<PATH>"', run_in_background: true })`
  4. 완료 알림 수신 후 `Bash({ command: 'rm -f "<PATH>"' })`로 정리

  **금지 사항**:
  - 호출 1에서 `focus_file=$(mktemp …)` 로 변수만 만들고 후속 Bash에서 `$focus_file` 참조 → **subshell 경계 넘지 못해 unset**. 절대 사용 금지.
  - `trap 'rm -f "$focus_file"' EXIT` 을 호출 1에 등록 → 호출 1의 EXIT가 즉시 발생해 background 호출 2가 파일을 읽기 전에 선제 삭제. Option A 내부에서만 trap을 사용한다.
  - `/tmp/deep-review-focus.txt` 같은 predictable name 사용 → race/symlink 공격.

여기서 `{codex_target_flag}`는:
- clean 또는 WIP 커밋 후: `--base {review_base}`
- dirty tree (WIP 거부, staged/unstaged/mixed): `--scope working-tree`
- **untracked-only 상태**: Stage 1.1 (세션 컨텍스트 추론) + Stage 3.0 (mutation protocol) 이 자동 처리. untracked 비-gitignored 파일은 Codex companion 의 `--scope working-tree` 모드가 `git ls-files --others --exclude-standard` 로 이미 수집하므로 별도 조치 불필요. gitignored 세션 파일은 Stage 1.1 로 감지 후 §3.0 mutation UX 로 사용자 승인 받아 처리. (v1.3.1 의 `--uncommitted` 기반 fallback 블록은 F8 (pre-existing bug) 교정으로 불필요해졌음.)

⚠️ 보안: focus_text는 rules.yaml/contract에서 생성되며 repo 파일이므로, 쉘 명령 문자열에 직접 삽입하면 안 된다. 반드시 stdin(`-` 인자 + 파일 리다이렉트)으로 전달할 것. 임시 파일 경로는 반드시 `mktemp` 기반 유니크 경로를 사용하고, 권한은 `600`으로 제한한다.

focus_text 생성:
- rules.yaml이 있으면: 아키텍처 규칙, 엔트로피 규칙에서 추출
- contract가 있으면: criteria 목록 추가
- 둘 다 없으면: "코드 품질, 버그, 아키텍처 문제를 집중 검토"

**Codex 플러그인 미설치 시 (codex_plugin=false):**
- `.deep-review/config.yaml`의 `codex_notified` 확인
- false이면 1회 안내:
  - codex_cli=false: "Codex 플러그인이 설치되어 있으면 교차 모델 검증이 가능합니다. 설치: `claude plugin add codex`"
  - codex_cli=true: "Codex CLI가 감지되었지만, 교차 모델 검증에는 Codex Claude Code 플러그인이 필요합니다. 설치: `claude plugin add codex`"
- `codex_notified`를 true로 업데이트 — **반드시 Edit tool로 해당 라인만 교체** (Write로 전체 덮어쓰기 금지):
  ```
  Edit(file_path: ".deep-review/config.yaml",
       old_string: "codex_notified: false",
       new_string: "codex_notified: true")
  ```
  이유: 사용자가 수정한 다른 필드(`review_model: sonnet`, `last_review`, `app_qa.*` 등)가 Write 전체 덮어쓰기로 silent loss 되는 것을 방지.

### 5. 합성 및 판정 (Stage 4: Verdict)

**5.0 복원 (Case 3 mutation 발생 시)**

모든 리뷰어 완료 알림 수신 후, 합성 **진입 직전** 복원:

```bash
source ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/mutation-protocol.sh
restore_mutation
```

- `is_our_ita_entry` 필터로 사용자가 리뷰 중 실제 staging 한 파일은 보존 (info 로그).
- state file 과 `.deep-review/.mutation.lock` 자동 제거.
- CR1 대응: perform_mutation 에서 trap 을 제거했으므로 lock 해제는 이 단계에서만 수행.

**5.1 합성 시작**

모든 백그라운드 리뷰어의 완료 알림이 수신된 후:
- Agent tool(`run_in_background`)과 Skill tool(`--background`)은 완료 시 자동 알림 반환
- polling 불필요 — Claude Code 런타임이 완료 알림을 자동 전달
- Opus background task 실패 시: "미수행"으로 표시, 실행된 리뷰어만으로 합성
- 부분 성공 시: 성공한 리뷰어 수 기준으로 합성 (3-way가 아닌 실제 수행된 N-way)

1. 교차 검증 합성 (Codex 결과가 있을 때):
   - 전원 일치 지적 → 🔴 높은 확신
   - 2/3 지적 → 🟡 중간 확신
   - 단독 지적 → 참고
   - 전원 통과 → 🟢

2. Verdict 결정:
   - 🔴 1건 이상 → **REQUEST_CHANGES**
   - 🟡만, 전원 일치 → **REQUEST_CHANGES**
   - 🟡만, 의견 분리 → **CONCERN**
   - 🟢만 → **APPROVE**

3. 리포트 저장: `.deep-review/reports/{YYYY-MM-DD}-{HHmmss}-review.md` (Bash `date "+%Y-%m-%d-%H%M%S"`로 파일명 생성 — 같은 날 재실행 시 덮어쓰기 방지)

3a. `config.yaml`의 `last_review`를 현재 ISO8601 시각으로 업데이트:
   ```
   Edit(file_path: ".deep-review/config.yaml",
        old_string: "last_review: {이전 값 또는 null}",
        new_string: "last_review: \"{현재 ISO8601}\"")
   ```
   이전 값을 먼저 Read로 확인한 후 교체 — 전체 Write 금지 (다른 필드 보존).

4. REQUEST_CHANGES 시:
   "대응 방법을 선택하세요:"
   (1) 증거 기반 대응 시작 (`/deep-review --respond`) ← 기본 추천
   (2) codex:rescue로 수정 위임 (Codex 설치 시에만 표시)
   (3) 수동으로 처리

### 5.5 Recurring Findings Export

리포트 생성 후 자동 실행. `.deep-review/reports/` 내 리포트가 2개 미만이면 건너뜀.

**Finding Taxonomy (v1.0):**

분류 카테고리:
- `error-handling` — try-catch 누락, 에러 전파 미흡
- `naming-convention` — 네이밍 불일치, 스타일 혼용
- `type-safety` — any 타입, 타입 단언 남용
- `test-coverage` — 테스트 누락, 경계값 미검증
- `security` — 인젝션, 인증/인가 미흡
- `performance` — N+1, 불필요한 재계산
- `architecture` — 순환 의존, 레이어 침범, SRP 위반

**프로세스:**

1. `.deep-review/reports/` 내 모든 리포트를 읽어 🔴 Critical + 🟡 Warning 항목 수집

2. 각 항목을 taxonomy 카테고리로 LLM 의미 기반 분류:
   - 항목의 설명과 코드 컨텍스트를 읽고 7개 카테고리 중 가장 적합한 것을 선택
   - 하나의 LLM 호출로 전체 항목을 일괄 분류 (호출 간 비결정성 방지)

3. 같은 카테고리가 3회 이상 나타나면 "recurring"으로 분류
   - 같은 카테고리에서 severity가 혼재하면 (critical + warning), 가장 높은 severity를 채택
   - 예: error-handling이 critical 3회, warning 2회이면 → severity: "critical", occurrences: 5

4. `.deep-review/recurring-findings.json`에 기록:

```json
{
  "updated_at": "<ISO 8601>",
  "taxonomy_version": "1.0",
  "findings": [
    {
      "category": "<taxonomy category>",
      "severity": "critical|warning",
      "occurrences": "<count>",
      "example_files": ["<file:line>"],
      "description": "<패턴 설명>",
      "source_reports": ["<report filename>"]
    }
  ]
}
```

5. 이 파일은 deep-evolve가 소비할 수 있는 표준 인터페이스 (init Stage 3.5에서 읽음).

### 6. 엔트로피 스캔 (--entropy)

`--entropy` 플래그가 있으면 추가 스캔:
- 프로젝트 전체에서 중복 코드 블록 탐지
- 기존 유틸리티와 중복되는 새 헬퍼 함수 탐지
- 네이밍 컨벤션 불일치 탐지
- 결과를 `.deep-review/entropy-log.jsonl`에 append

### 7. App QA (--qa) — 향후 릴리스 예정

현재는 미구현 상태입니다. `--qa` 플래그를 사용하면: "App QA는 향후 릴리스에서 지원 예정입니다. 현재 `config.yaml`의 `app_qa.*` 필드는 예약 스키마이며 값을 기록하지 않습니다."

구현 로드맵은 `CHANGELOG`의 미래 항목을 참고하세요. 현재 해당 기능은 명시적으로 백로그에 있으며 v1.1 시점 약속은 연기되었습니다.

---

## Steps (대응 모드 — `--respond` 인수)

### 0. 자동 복원 + tmp 회전

리뷰 모드 §0.1 과 동일한 mutation 자동 복원 후, Phase 6 tmp 로그를 1단계 회전.

```bash
source ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/mutation-protocol.sh
auto_recover

# Phase 6 tmp 로그 1단계 회전 — 직전 세션 로그는 prev/로 보존, 2회 이전은 자동 소멸
if compgen -G ".deep-review/tmp/phase6-*.log" > /dev/null 2>&1; then
  mkdir -p .deep-review/tmp/prev
  rm -f .deep-review/tmp/prev/phase6-*.log 2>/dev/null || true
  mv .deep-review/tmp/phase6-*.log .deep-review/tmp/prev/ 2>/dev/null || true
fi
```

회전 근거와 상세 정책은 스펙 §6.9 참조.

### Prerequisites

`receiving-review` 스킬을 **다음 순서대로** 로드한다 (`user-invocable: false` 스킬이 Skill tool로 안정적으로 로드되지 않는 환경에 대비한 fallback 경로):

1. 1차 시도: `Skill({ skill: "deep-review:receiving-review" })` — 플러그인 네임스페이스 포함
2. 1차 실패 시 2차 시도: `Skill({ skill: "receiving-review" })` — 네임스페이스 없이
3. 2차도 실패 시 Read fallback:
   - `Read({ file_path: "${CLAUDE_PLUGIN_ROOT}/skills/receiving-review/SKILL.md" })`
   - 필요한 references도 Read로 로드: `references/response-protocol.md`, `references/forbidden-patterns.md`, `references/response-format.md`
4. 어떤 경로든 성공하면 Phase 1~6을 실행한다. 실패 경로는 Response 리포트의 Summary에 "skill load method: Skill | Read fallback" 으로 기록.

### 1. 리포트 로딩

- `--respond {path}` → 지정된 리포트 로드 (경로 그대로 사용)
- `--respond` (경로 없음) → `.deep-review/reports/` 내 **mtime 기준 가장 최근** `*-review.md` 로드:
  ```bash
  latest=$(ls -1t .deep-review/reports/*-review.md 2>/dev/null | head -1)
  ```
  `-ultrareview.md` 같은 비표준 접미사 파일은 `*-review.md` glob에서 제외되어 수동 리뷰와 일상 리뷰가 섞이지 않는다.
  mtime 정렬이므로 파일명 포맷이 변경되어도(과거 `{date}-review.md` ↔ 현재 `{date}-{time}-review.md`) 안전.
- `--respond --source=pr` → GitHub PR 코멘트를 `gh api`로 수집 (`--pr=NNN`로 수동 지정 가능)
- 리포트가 여러 개인데 사용자가 원하는 파일이 mtime 최신이 아닐 수 있으므로, 최근 3개 리포트의 Summary를 나열하고 AskUserQuestion으로 선택을 제공하는 것을 **권장**(필수 아님).
- 리포트가 없으면: "대응할 리뷰 리포트가 없습니다. 먼저 `/deep-review`를 실행하세요."

**참고**: `--source=pr`과 `REPORT_PATH`는 상호 배타적이다. 둘 다 지정하면 `--source=pr`이 우선하고 `REPORT_PATH`는 무시된다.

**리포트 확인 (같은 날 덮어쓰기 방지)**:
리포트 로드 후, 사용자에게 Summary(Verdict, Review Mode, Issues 요약)를 표시하고 "이 리포트에 대응하시겠습니까?" 확인을 받는다. 리포트 파일명은 이제 `{YYYY-MM-DD}-{HHmmss}-review.md` 타임스탬프 기반이므로 덮어쓰기는 발생하지 않지만, 같은 날 여러 리뷰가 있을 경우 사용자가 어떤 리포트에 대응할지 혼동할 수 있다. 확인 단계를 통해 잘못된 리포트에 대응하는 것을 방지한다.

### 2. receiving-review Phase 1~5 (main)

로드된 `receiving-review` 스킬의 Phase 1~5를 main 세션에서 실행합니다.
- Phase 1~5: READ / UNDERSTAND / VERIFY / EVALUATE / RESPOND — ACCEPT/REJECT/DEFER 판단까지.
- 각 ACCEPT 항목에 `implementation_guide` 6개 필드(`target_location`/`modifiable_paths`/`intent`/`change_shape`/`non_goals`/`acceptance`)를 기록.
- Accepted Items를 5단계 우선순위(🔴 전원일치 → 🔴 부분일치 → 🟡 전원일치 → 🟡 부분일치 → ℹ️)로 정렬, `confidence: agreed | partial` 필드 세팅.
- Recurring findings 분류 및 경고는 Phase 1(READ) 내부에서 처리.

### 2.5 Phase 6 — subagent dispatch (심각도 그룹 loop)

Phase 6 구현은 `phase6-implementer` 서브에이전트에 그룹 dispatch. 상세 스펙: `docs/superpowers/specs/2026-04-24-phase6-subagent-delegation-design.md` §3, §5, §6.

**심각도 그룹 loop** (🔴 → 🟡 → ℹ️):

**실행 가능한 e2e 테스트**: 아래 각 Step의 핵심 shell 로직은 `hooks/scripts/test/test-phase6-protocol-e2e.sh`의 5개 테스트(E1~E5)에서 실증 검증됨. pseudocode가 문서로 drift하지 않도록 **CI에서 e2e도 함께 실행**.

1. 해당 그룹의 ACCEPT 항목이 0건이면 skip.
2. 로그 경로 결정: `log_path="$(pwd)/.deep-review/tmp/phase6-${severity}.log"` (절대 경로). `mkdir -p .deep-review/tmp`.
3. **Pre-dispatch snapshot** — allowlist + content-aware baseline:
   ```bash
   # Allowlist = target_location 경로 union modifiable_paths (스펙 §5.1 계약)
   # TARGET_LOCATIONS_OF_GROUP, MODIFIABLE_PATHS_OF_GROUP = Accepted Items 파싱 결과
   # target_location은 "src/a.ts:45-60" 형식 또는 comma-separated 다중 경로 허용 — line-range strip
   ALLOWED=$(printf '%s\n' "${TARGET_LOCATIONS_OF_GROUP[@]}" "${MODIFIABLE_PATHS_OF_GROUP[@]}" \
     | tr ',' '\n' \
     | sed -E 's/:[0-9][0-9,\-]*\s*$//; s/^[[:space:]]+//; s/[[:space:]]+$//' \
     | sort -u | sed '/^$/d')

   # Path set baseline (violation 검출용)
   PRE_MODIFIED=$(git -c core.quotepath=false diff --name-only | sort -u)
   PRE_UNTRACKED=$(git -c core.quotepath=false ls-files --others --exclude-standard | sort -u)
   PRE_STATUS=$(git -c core.quotepath=false status --porcelain=v1 -uall)

   # Content snapshot — ALLOWED 각 파일에 대해 per-file 복사 (Dirty recovery 용)
   mkdir -p ".deep-review/tmp/phase6-${severity}-baseline"
   declare -A PRE_HASH=()
   while IFS= read -r f; do
     [[ -z "$f" ]] && continue
     if [[ -f "$f" ]]; then
       PRE_HASH[$f]=$(git hash-object -- "$f")
       # per-file baseline copy (preserves user WIP content)
       mkdir -p ".deep-review/tmp/phase6-${severity}-baseline/$(dirname "$f")"
       cp -p "$f" ".deep-review/tmp/phase6-${severity}-baseline/$f"
     else
       PRE_HASH[$f]="absent"
     fi
   done <<< "$ALLOWED"
   ```
4. **Dispatch 2단계 네임스페이스 fallback**:
   - 환경변수 `DEEP_REVIEW_FORCE_FALLBACK=1` 이 설정되면 dispatch 건너뛰고 즉시 main fallback 경로로 분기 (단, baseline 보존 상태).
   - 1차: `Agent({ subagent_type: "deep-review:phase6-implementer", prompt: <§5.1 계약> })`
   - 1차가 "subagent_type not found" 또는 유사 에러 반환 시 2차: `Agent({ subagent_type: "phase6-implementer", prompt: <§5.1 계약> })`
   - 2차도 실패 또는 permission refusal 등 dispatch 자체 실패 시 → main fallback 분기.
5. **결과 검증 (dispatch 성공 시) — fail-closed + content-aware delta + allowlist**:
   - 반환 메시지에 `## Group Result` 블록이 **없거나 파싱 불가능**하면 dispatch 실패로 재분류 → Step 7 "Dirty recovery"로 분기.
   - **Content-aware DELTA** (E2 검증): ALLOWED 각 경로의 hash를 post-dispatch와 비교. content 변경된 경로만 포함:
     ```bash
     DELTA=()
     for f in "${!PRE_HASH[@]}"; do
       post=$([[ -f "$f" ]] && git hash-object -- "$f" || echo "absent")
       [[ "$post" != "${PRE_HASH[$f]}" ]] && DELTA+=("$f")
     done
     ```
   - **Path-set violation** — ALLOWED 외부 경로가 수정/생성됐는지 별도 체크 (trust boundary):
     ```bash
     POST_MODIFIED=$(git -c core.quotepath=false diff --name-only | sort -u)
     POST_UNTRACKED=$(git -c core.quotepath=false ls-files --others --exclude-standard | sort -u)
     NEW_PATHS=$(printf '%s\n%s\n' \
       "$(comm -13 <(echo "$PRE_MODIFIED") <(echo "$POST_MODIFIED"))" \
       "$(comm -13 <(echo "$PRE_UNTRACKED") <(echo "$POST_UNTRACKED"))" \
       | sort -u | sed '/^$/d')
     VIOLATIONS=$(comm -23 <(echo "$NEW_PATHS") <(echo "$ALLOWED"))
     [[ -n "$VIOLATIONS" ]] && { execution_status=error; error_reason="outside allowlist: $VIOLATIONS"; }
     ```
   - **서브에이전트 claim 정규화 + delta 일치 검증** (E1 검증):
     ```bash
     # subagent emits "path/to/file (+A -B)" — suffix strip before compare
     CLAIM=$(printf '%s\n' "${CHANGED_FILES_CLAIM_RAW[@]}" \
       | sed -E 's/ \(\+[0-9]+ -[0-9]+\)$//' \
       | sort -u)
     DELTA_SORTED=$(printf '%s\n' "${DELTA[@]}" | sort -u)
     if [[ "$CLAIM" != "$DELTA_SORTED" ]]; then
       execution_status=error
       error_reason="files_changed claim != content-aware delta"
     fi
     ```
   - **REVERTED symmetric check** — 서브에이전트가 기존 파일 revert 시 감지:
     ```bash
     # PRE_ALL에 있었는데 POST_ALL에서 사라진 파일 (content-aware가 DELTA에 안 잡음)
     REVERTED=$(comm -23 \
       <(printf '%s\n' "$PRE_MODIFIED" "$PRE_UNTRACKED" | sort -u | sed '/^$/d') \
       <(printf '%s\n' "$POST_MODIFIED" "$POST_UNTRACKED" | sort -u | sed '/^$/d'))
     [[ -n "$REVERTED" ]] && { execution_status=error; error_reason="subagent reverted pre-existing changes: $REVERTED"; }
     ```
   - `log_path` 존재 가드:
     ```bash
     [[ ! -f "$log_path" ]] && { log_unavailable=true; execution_status=error; }
     ```
   - 실패 항목은 `Read(log_path)` — `ITEM-{id}` 구분자로 구간 확인.
   - **검증 통과 시**: `CHANGED_FILES=("${DELTA[@]}")` 확정.
6. **그룹 커밋 — pathspec-limited**: 전원 PASS AND Step 5 검증 통과 시에만:
   - 빈 배열 가드: `[[ ${#CHANGED_FILES[@]} -eq 0 ]]`면 이상 상태 → `execution_status=error`.
   - **Untracked 신규 파일 명시적 add** (NUL-safe, E5-adjacent):
     ```bash
     while IFS= read -r f; do
       [[ -z "$f" ]] && continue
       # 신규 untracked 파일 (PRE에 없었음) 에만 git add
       if [[ -z "${PRE_HASH[$f]+x}" || "${PRE_HASH[$f]}" == "absent" ]]; then
         git add -- "$f"
       fi
     done < <(printf '%s\n' "${CHANGED_FILES[@]}")
     ```
   - **Pre-staged 경고** (E3 fix — 올바른 `:(exclude)` 확장):
     ```bash
     # EXCL 배열을 for 루프로 구성 (":(exclude)${arr[@]}"는 첫 요소에만 prefix 붙는 버그 회피)
     EXCL=()
     for f in "${CHANGED_FILES[@]}"; do EXCL+=(":(exclude)$f"); done
     if ! git diff --cached --quiet -- . "${EXCL[@]}" 2>/dev/null; then
       echo "⚠ Pre-staged files detected outside Phase 6 scope:"
       git -c core.quotepath=false diff --cached --name-only -- . "${EXCL[@]}" || true
       echo "→ These files remain staged in the index but are NOT included in this commit (git commit --only semantics)."
     fi
     ```
   - **Same-file pre-staged hunk 경고** — `git commit --only path`는 path 전체를 커밋하므로 사용자가 미리 staged한 hunk가 같은 path에 있으면 auto-commit에 섞임:
     ```bash
     SAMEFILE_PRESTAGED=()
     for f in "${CHANGED_FILES[@]}"; do
       if git diff --cached --quiet -- "$f" 2>/dev/null; then :; else
         SAMEFILE_PRESTAGED+=("$f")
       fi
     done
     if [[ ${#SAMEFILE_PRESTAGED[@]} -gt 0 ]]; then
       echo "⚠ Files in CHANGED_FILES also have pre-staged hunks — auto-commit will include BOTH pre-staged and Phase 6 changes:"
       printf '  %s\n' "${SAMEFILE_PRESTAGED[@]}"
       # AskUserQuestion: continue (merge) / abort (skip commit, user 수동 판단)
     fi
     ```
   - **커밋** — `-m`은 `--` **앞에**:
     ```bash
     git commit --only -m "fix(review-response): resolve {severity} items from {report_basename}" -- "${CHANGED_FILES[@]}"
     ```
   - **금지**: `git add -A`, `git commit` (pathspec 없이), `git commit --only -- <paths> -m <msg>` (`-m`이 pathspec으로 파싱됨).
   - 부분 실패/halted/error 그룹은 커밋 건너뜀. response.md에 "워킹 트리에 passed 항목 수정 남음" 경고 기록.
7. **Dirty recovery — per-file content baseline** (E5 검증):
   - `git status --porcelain=v1 -uall` 로 POST_STATUS 수집, `PRE_STATUS != POST_STATUS` 이면 dirty 상태 남음.
   - AskUserQuestion:
     > "서브에이전트가 dirty 상태로 중단됐습니다. 어떻게 할까요?
     > (1) 유지하고 main 계속 (partial edits 위에 쌓음 — 권장 안 함)
     > (2) baseline으로 restore (**per-file content snapshot 사용** — 사용자 WIP 보존)
     > (3) 중단, 사용자 수동 판단"
   - (2) 선택 시 — **`git restore --source=HEAD` 사용 금지** (pre-existing WIP 파괴). 대신 Step 3에서 저장한 per-file baseline을 복원:
     ```bash
     # ALLOWED 경로만 baseline content로 복원 (사용자의 non-ALLOWED dirty는 건드리지 않음)
     while IFS= read -r f; do
       [[ -z "$f" ]] && continue
       baseline=".deep-review/tmp/phase6-${severity}-baseline/$f"
       if [[ -f "$baseline" ]]; then
         mkdir -p "$(dirname "$f")"
         cp -p "$baseline" "$f"
       elif [[ "${PRE_HASH[$f]}" == "absent" && -f "$f" ]]; then
         # PRE에 없던 파일 (서브에이전트가 생성) → 삭제
         rm -f "$f"
       fi
     done <<< "$ALLOWED"
     ```
   - (3) 선택 시 response.md에 현재 상태 snapshot 기록 후 종료.
8. **중단 판정**: `execution_status in (halted_on_regression, error)` 또는 `items_failed > 0`이면 다음 그룹 dispatch 안 함. 스킵된 후속 항목은 `decision: DEFER, defer_reason: "halted at {severity} group"`로 기록.

**Main fallback 분기** (dispatch 실패):

1. 경고 출력: `⚠ phase6-implementer dispatch failed ({reason}). Falling back to in-session execution.`
2. **Context 여력 안전장치** — 남은 미처리 항목 수(현재 그룹 + 후속 그룹) ≥ 5 이면 AskUserQuestion:
   > (1) 여기까지 — 남은 항목을 DEFER로 기록 후 종료 / (2) 계속 진행 (context 소진 위험).
3. (1) 선택: 남은 항목 `decision: DEFER, defer_reason: "dispatch failure, main context conservation"`로 기록하고 Step 3으로.
4. (2) 또는 N < 5: main이 직접 receiving-review Phase 6 로직으로 구현 (한 항목씩, 매 항목 테스트, 회귀 시 즉시 중단).
5. response.md Summary `execution_path` 필드에 `main_fallback` 또는 `mixed` 기록 (스펙 §5.4 결정표 참조).

**`execution_path` 값 결정**:

| 시나리오 | 값 |
|---------|-----|
| 전 그룹 subagent 성공 | `subagent` |
| 1st dispatch 시도부터 실패 | `main_fallback` |
| 일부 subagent + 일부 fallback | `mixed` |
| ACCEPT 0건 | `n/a` |

### 3. Response 리포트 저장

`.deep-review/responses/` 디렉토리가 없으면 생성:
```bash
mkdir -p .deep-review/responses
```

Response 리포트를 `.deep-review/responses/{YYYY-MM-DD}-{HHmmss}-response.md`에 저장.

### 4. Re-review 제안

"대응이 완료되었습니다. `/deep-review`를 재실행하여 변경사항을 검증하시겠습니까?"

---

## Steps (init 모드 — 인수가 "init"일 때)

### 1. 기존 설정 확인

`.deep-review/` 디렉토리가 이미 존재하는지 확인합니다.
- 존재하면: AskUserQuestion "이미 초기화되어 있습니다. 다시 초기화할까요?"
- 없으면: 진행

### 2. 디렉토리 생성

```bash
mkdir -p .deep-review/contracts
mkdir -p .deep-review/reports
mkdir -p .deep-review/journeys
```

### 3. 프로젝트 분석

코드베이스를 탐색하여 아키텍처 규칙을 추론합니다:

1. **언어/프레임워크 감지**: package.json, pyproject.toml, Cargo.toml 등
2. **디렉토리 구조 분석**: src/, lib/, components/ 등의 패턴
3. **기존 린터 규칙**: .eslintrc, .prettierrc, ruff.toml 등에서 스타일 규칙 추출
4. **네이밍 컨벤션**: 기존 파일/함수의 네이밍 패턴 분석

### 4. 사용자와 대화형 규칙 설정 (AskUserQuestion)

분석 결과를 바탕으로 AskUserQuestion으로 질문:

"프로젝트를 분석했습니다. 다음 규칙을 적용할까요?"

**(A) 아키텍처 레이어:**
- 감지된 레이어 구조 제시 (또는 "감지된 구조 없음")
- 사용자가 수정/추가/건너뛰기 가능

**(B) 스타일 규칙:**
- 감지된 네이밍 컨벤션, 파일 크기 제한 등
- 기존 린터 규칙과 통합

**(C) 엔트로피 규칙:**
- 공유 유틸리티 선호 여부
- 유사 블록 반복 허용 횟수

### 5. config.yaml 생성

```yaml
# .deep-review/config.yaml
review_model: opus
codex_notified: false
last_review: null
app_qa:
  last_command: null
  last_url: null
```

### 6. rules.yaml 생성

사용자 확인을 받은 규칙으로 생성합니다. 예시:

```yaml
# .deep-review/rules.yaml
# Generated by /deep-review init on {날짜}

architecture:
  layers: []          # 사용자 정의 또는 빈 배열
  direction: top-down
  cross_cutting: []

style:
  max_file_lines: 300
  naming: null        # 감지된 컨벤션 또는 null
  logging: null

entropy:
  prefer_shared_utils: true
  max_similar_blocks: 3
  validate_at_boundaries: true
```

### 7. Fitness.json 안내

"아키텍처 규칙을 계산적으로 강제하려면 deep-work의 fitness.json을 사용하세요.
 /deep-work 세션 Phase 1에서 자동으로 fitness.json 생성을 제안합니다.
 rules.yaml은 LLM이 판단하는 inferential 규칙, fitness.json은 코드가 검증하는 computational 규칙입니다."

### 8. .gitignore 업데이트

`.gitignore`에 아래 블록이 없으면 추가 제안:

```
# deep-review — runtime 상태 및 로컬 리뷰 출력
.deep-review/config.yaml
.deep-review/reports/
.deep-review/responses/
.deep-review/entropy-log.jsonl
.deep-review/recurring-findings.json
.deep-review/.pending-mutation.json
.deep-review/.mutation.lock/
.deep-review/tmp/
```

**커밋 정책**:
- **Tracked (팀 공유)**: `rules.yaml`, `contracts/`, `journeys/` — 프로젝트 지식 자산
- **Untracked (머신별)**:
  - `config.yaml` — runtime 상태
  - `reports/`, `responses/` — 세션별 출력
  - `entropy-log.jsonl`, `recurring-findings.json` — 증적
  - `.pending-mutation.json` — mutation state (세션 생명주기)
  - `.mutation.lock/` — mutex lock dir
  - `tmp/` — Phase 6 subagent 로그 (1단계 회전, 직전 세션은 `tmp/prev/`)
- 사용자가 팀에서 recurring 패턴을 공유하려면 `recurring-findings.json`만 선택적으로 tracked 가능

### 9. 완료 메시지

"deep-review 초기화 완료. `/deep-review`로 리뷰를 시작하세요."

(이 init 로직은 메인 커맨드 deep-review.md의 "init 모드" 섹션에 포함되어 있음 — 별도 커맨드 파일 없음)
