---
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent, Skill, AskUserQuestion
description: 현재 변경사항을 독립 에이전트로 리뷰합니다. init으로 규칙 초기화, --contract로 Sprint Contract 기반 검증, --entropy로 엔트로피 스캔, --respond로 리뷰 피드백 대응. --ultracode(멀티에이전트 Claude 리뷰)·--codex(Codex 2-way)·--codex-only(Codex만) 등 합성 플래그로 리뷰어 구성을 조절.
argument-hint: "[init] [--contract [SLICE-NNN]] [--entropy] [--ultracode] [--codex|--no-codex] [--no-opus] [--no-agy] [--codex-only] [--respond (REPORT_PATH | --source=pr [--pr=NNN])]"
---

# /deep-review — Independent Code Review

현재 코드 변경사항을 독립된 Evaluator 에이전트로 리뷰합니다.

> 리뷰 → 대응 → 재리뷰 를 한 세션에서 자동 반복하려면 [`deep-review-loop` skill](../skills/deep-review-loop/SKILL.md) 을 사용하세요 (`/deep-review-loop` 또는 `Skill({ skill: "deep-review:deep-review-loop" })`). v1.5.0+ command 였으며 v1.6.0 부터 skill 로 마이그레이션되어 Codex 등 cross-platform 진입이 가능합니다.

## Argument Dispatch

- `init` → "init 모드" 섹션으로 분기 (프로젝트별 규칙 초기화)
- `--respond` → "대응 모드" 섹션으로 분기 (리뷰 피드백 대응)
- `--qa` → 안내 메시지 후 즉시 종료:
  "App QA(`--qa`)는 향후 릴리스에서 지원 예정입니다. 현재 `.deep-review/config.yaml`의 `app_qa.*` 필드는 예약 스키마로만 유지되며 동작하지 않습니다."
- `--contract` / `--entropy` / 인수 없음 → "리뷰 모드"로 진행

## 0.5 플래그 파싱 & 검증 (reviewer 구성 플래그, 순서 고정)

리뷰 모드에서 reviewer 구성 플래그를 파싱·검증한다. **반드시 다음 순서** (순서가 결과를 바꾼다):

1. **슈가 전개 (먼저)**: `--codex-only` → `--codex --no-opus --no-agy` 로 전개한다. 검증을 raw 토큰에 먼저 하면 `--ultracode --codex-only` 가 모순 검사를 통과해버려 ultracode 가 무음 드롭된다 — 전개를 검증보다 먼저 한다.
2. **모순 검증 (전개된 집합 기준)**:
   - `--ultracode` + `--no-opus` → **모순 에러**(즉시 종료): "`--no-opus`는 Claude 리뷰어를 끄고 `--ultracode`는 업그레이드합니다. 하나만 쓰세요." (전개 후 기준이므로 `--ultracode --codex-only` 도 동일 에러)
   - `--codex` + `--no-codex` → 모순 에러(동일 패턴).
3. **플래그/위치 인자 분리**: 새 플래그는 모두 `--` 접두. `--contract` 의 선택 인자는 **다음 토큰이 `SLICE-[0-9]+` 패턴일 때만** 소비(아니면 bare `--contract`), `--respond` 의 `REPORT_PATH` 는 **존재하는 파일 경로일 때만** 소비. 따라서 `--contract --codex` / `--respond --codex` 에서 `--codex` 가 SLICE id·REPORT_PATH 로 오소비되지 않는다.

검증 통과 후:
- **`--respond` + reviewer 플래그 조합**: `--respond` 는 대응 모드라 reviewer 플래그가 무의미 → **하드 에러 아님**, 1줄 안내만: "reviewer 구성 플래그는 리뷰 모드 전용 — `--respond` 에서는 무시됩니다." (기존 `--qa` 안내 패턴과 동일.)

이 절은 runtime 동작의 문서화다 — 실제 실행은 Claude Code 가 본 markdown 의도를 읽어 수행한다.

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
agy_notified: false
agy_enabled: true
agy_sensitive_acked_fingerprint: ""
agy_sensitive_acked_at: ""
agy_fingerprint_mode: hybrid
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

### 0.2 agy 필드 마이그레이션 (v1.6.x → v1.7.0+)

`auto_recover` 완료 후, config.yaml 에 agy 관련 필드가 없는 v1.6.x 사용자를 위해 idempotent 마이그레이션을 수행한다:

```bash
# Migration: probe each new agy field independently. Anchor on last_review:
# (value-agnostic) — NOT on codex_notified: false (C-R5-3: value can be true, matching would fail on v1.6.x with codex_notified: true).
# Use `grep -q '^agy_notified:' .deep-review/config.yaml` with SPACE before filename.
grep -q '^agy_notified:'                    .deep-review/config.yaml || NEED_NOTIFIED=1
grep -q '^agy_enabled:'                     .deep-review/config.yaml || NEED_ENABLED=1
grep -q '^agy_sensitive_acked_fingerprint:' .deep-review/config.yaml || NEED_ACK=1
grep -q '^agy_sensitive_acked_at:'          .deep-review/config.yaml || NEED_ACK_AT=1
grep -q '^agy_fingerprint_mode:'            .deep-review/config.yaml || NEED_FP_MODE=1   # v1.7.1

block=""
[ "${NEED_NOTIFIED:-0}" = 1 ] && block="${block}agy_notified: false"$'\n'
[ "${NEED_ENABLED:-0}"  = 1 ] && block="${block}agy_enabled: true"$'\n'
[ "${NEED_ACK:-0}"      = 1 ] && block="${block}agy_sensitive_acked_fingerprint: \"\""$'\n'
[ "${NEED_ACK_AT:-0}"   = 1 ] && block="${block}agy_sensitive_acked_at: \"\""$'\n'
[ "${NEED_FP_MODE:-0}"  = 1 ] && block="${block}agy_fingerprint_mode: hybrid"$'\n'   # v1.7.1

if [ -n "$block" ]; then
  # Use Edit tool, not Write — preserve user-customized review_model / last_review / app_qa
  # The `new_string` is DYNAMICALLY built so partial migrations don't duplicate keys
  # or reset user's `agy_enabled: false` to `true` (R5/R6 carry-forward).
  Edit(file_path: ".deep-review/config.yaml",
       old_string: "last_review:",
       new_string: "${block}last_review:")
fi
```

**주의사항:**
- `grep -q '^agy_notified:'` — 행 시작(`^`) 앵커와 파일명 앞 **공백**이 필수 (W-R5-1: 공백 누락 시 silent no-match).
- 앵커를 `codex_notified: false` 값에 두지 않음 — v1.6.x 사용자는 이미 `codex_notified: true` 상태일 수 있어 마이그레이션 no-op 가능성 있음 (C-R5-3).
- `block` 변수를 NEED_* 플래그로 동적으로 구성 — 부분 마이그레이션(키 일부만 없는 경우)에서도 중복 삽입 없음.

## Steps (리뷰 모드)

### 1. 환경 감지

```bash
bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/detect-environment.sh
```

결과를 key=value 형식으로 파싱하여 환경 상태를 파악합니다.
Codex 또는 다른 non-Claude 런타임에서는 `claude_cli` / `claude_cli_path`도 함께 확인한다. 이는 Claude Code `Agent` tool이 없는 환경에서 Opus reviewer를 `hooks/scripts/run-claude-reviewer.sh` CLI bridge로 실행하기 위한 preflight 값이다.

**shallow clone (is_shallow=true) 감지 시:**
- "shallow clone에서는 review base가 부정확할 수 있습니다. `git fetch --unshallow`를 권장합니다." 안내
- HEAD~1 fallback으로 진행

**agy 변수 (v1.7.0 신규)**:
- `agy_cli`, `agy_cli_path`, `agy_version` — `_emit_agy_vars` 가 모든 detection path 에서 emit (Task 2)
- `agy_enabled` (config) — false 면 detection 결과와 무관하게 reviewer 제외

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
       (tracked 파일의 수정분만 커밋. untracked 파일은 포함하지 않음 — **이 untracked 파일들은 이번 Codex 리뷰 대상에서 제외된다**. 신규로 추가한 핵심 파일이 untracked 라면 옵션 B 를 선택해 명시적으로 포함해야 cross-model 검증이 의미를 가진다.)
     - 옵션 B (수락 — 전체): untracked 파일까지 포함하려는 경우, 먼저 파일 목록을 다시 확인시킨 뒤
       `git add <explicit files> && git commit -m "wip: deep-review checkpoint"` 로 명시적 add
     - 옵션 C (거부): diff 기반으로 진행 (Claude Opus + 가능하면 Codex도)
  4. 수락 시 안내: "리뷰 완료 후 `git reset --soft HEAD~1`로 WIP 커밋을 해제할 수 있습니다."
  5. `git add -A`는 사용하지 않음 — 민감 파일 무분별 스테이징을 방지.

**git + untracked-only:**
- `git ls-files --others --exclude-standard`로 파일 목록 수집 후 내용 읽기

**dirty working-tree 상태(staged/unstaged/mixed/untracked-only)에서 untracked > 0이면:**
- `git ls-files --others --exclude-standard`로 추가 파일을 리뷰 대상에 포함 (primary state 의 diff 와 union).
- **단, `clean` 은 union에서 제외** — clean 의 실효 대상은 커밋된 `review_base..HEAD` 이므로 leftover untracked 파일은 그 대상 집합에 없다(unioning 하면 out-of-scope 파일 유출, spec §4.1). `initial` 은 자체 `--cached --others` 열거를 쓴다. 이 규칙은 `build-change-files.sh` 의 `if state in ("staged","unstaged","mixed","untracked-only")` union 분기와 **글자 그대로 일치**해야 한다(diff 와 change_files manifest 의 대상 집합 일치).

diff에서 제외 (**Stage-1 표준 제외 목록 — 이 줄이 단일 출처(SoT)**. `hooks/scripts/build-change-files.sh` 의 `EXCLUDE_SEGMENTS`/`EXCLUDE_BASENAME_GLOBS` 와 **멤버십이 글자 그대로 동일**해야 한다 — diff 와 change_files manifest 의 대상 집합 불일치 방지, spec §4.1):
- 디렉토리 세그먼트: `node_modules/`, `dist/`, `build/`, `.next/`, `target/`, `.venv/`, `__pycache__/`, `.pytest_cache/`, `vendor/`, `.git/`
- 파일명 글로브: `*.min.js`, `*.generated.*`, `*.lock`, `.DS_Store`
- 바이너리 (best-effort: `git diff --numstat` 가 `-\t-` 로 표시하는 블롭)

### 2.1 세션 컨텍스트 기반 대상 확장 (Case 3 전용)

`codex_plugin=true AND is_git=true AND codex_included`(= `--no-codex` 아님) 인 경우, 기존 수집으로 산출된 `opus_target_git` 을 아래 절차로 확장 (spec §3.1).

> **SEC-CODEX-1**: `--no-codex`(또는 `codex_included=false`) 면 codex 가 실행되지 않으므로 §2.1 세션 추론 + §2.2 갭 감지 + §3.0 mutation/노출 UX 를 **전부 건너뛴다** (mutation lock 미획득·`git add -f -N` 미수행). 이는 SEC-1 의 agy 게이트 short-circuit 과 대칭이다.

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

### 3.5 agy sensitive-file acknowledgment (pre-spawn gate, fingerprint-based)

**SEC-1 — `agy_included` 로 게이팅**: §4 리뷰어 열거의 `agy_included`(= `agy_cli && agy_enabled && NOT --no-agy && NOT AGY_USER_DECLINED_THIS_RUN`)를 이 게이트 **이전에** 계산하고, `agy_included=false` 면 본 Stage 3.5(find/scan 포함)를 **건너뛴다**. 특히 `--no-agy`(또는 `--codex-only` 전개)면 민감파일 스캔·프롬프트를 수행하지 않으며 `agy_sensitive_acked_fingerprint` 도 **변경하지 않는다**. (기존: raw `agy_cli && agy_enabled` 만 보면 `--no-agy` 로 agy 를 제외해도 민감파일 노출 프롬프트가 떴음.)

If `agy_included=true`: run this gate before spawning any reviewer. Otherwise: skip.

(Note: Stage 3.5 may set AGY_USER_DECLINED_THIS_RUN=1 if the user picks "N" in the AskUserQuestion.
The reviewer-enumeration block at §4 consults `agy_included` which incorporates `agy_cli && agy_enabled` (config) AND the `--no-agy` flag AND this session flag, so the user's per-run decline is honored without persisting any config change.)

**Critical (R7 carry-forward C-R7-1)**: `scan_sensitive_files` 은 `mutation-protocol.sh` 의 bash function 이며 외부 명령이 아니다. `xargs` 로 호출 불가. while-read 루프 사용:

```bash
source "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/mutation-protocol.sh"

# Portable sha256 shim (W-R7-5).
_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1
  elif command -v shasum   >/dev/null 2>&1; then shasum -a 256 | cut -d' ' -f1
  else openssl dgst -sha256 -r | cut -d' ' -f1
  fi
}

# C2: Build file list — NO depth limit (matches agy's --add-dir full-tree reach).
# Removing -maxdepth 5 ensures sensitive files at depth 6+ are not silently bypassed.
# Excluded directories are build/dependency caches only — not legitimate secret locations.
# Scan covers full project tree (matching agy's --add-dir reach).
# Excluded directories: .git/, node_modules/, .venv/, __pycache__/, dist/, build/, target/
# (build/dependency caches only — not legitimate secret locations).
project_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
paths_file=$(mktemp "${TMPDIR:-/tmp}/agy-paths.XXXXXX")
find_err=$(mktemp "${TMPDIR:-/tmp}/agy-find-err.XXXXXX")
find "$project_root" -type f \
  -not -path '*/.git/*' \
  -not -path '*/node_modules/*' \
  -not -path '*/.venv/*' \
  -not -path '*/__pycache__/*' \
  -not -path '*/.pytest_cache/*' \
  -not -path '*/dist/*' \
  -not -path '*/build/*' \
  -not -path '*/target/*' \
  -not -path '*/.next/*' \
  -not -path '*/.svelte-kit/*' \
  -not -path '*/coverage/*' \
  -not -path '*/out/*' \
  -not -path '*/.gradle/*' \
  -not -path '*/.cargo/*' \
  -not -path '*/vendor/*' \
  -not -path '*/.terraform/*' \
  -print0 2>"$find_err" > "$paths_file"
if [ -s "$find_err" ]; then
  echo "⚠️ agy scan: find encountered errors:" >&2
  head -10 "$find_err" >&2
  echo "(showing first 10 lines; deletion follows for cleanup)" >&2
fi

# C-R7-1 fix: while-read invocation (xargs can NOT call bash functions).
hits=""
while IFS= read -r -d '' f; do
  if scan_sensitive_files "$f" 2>/dev/null | grep -q .; then
    hits="${hits}${f}"$'\n'
  fi
done < "$paths_file"
hits="${hits%$'\n'}"
rm -f "$paths_file" "$find_err"

# Compute current fingerprint.
if [ -z "$hits" ]; then
  current_fingerprint=$(printf '' | _sha256)
else
  current_fingerprint=$(printf '%s\n' "$hits" | sort -u | tr '\n' '\0' | _sha256)
fi

# Read stored fingerprint from config.
stored=$(grep '^agy_sensitive_acked_fingerprint:' .deep-review/config.yaml \
         | sed -E 's/^agy_sensitive_acked_fingerprint: *"?([^"]*)"?$/\1/')

# Decision logic (W-R7-2 fix: special-case empty stored as wildcard for no-hits clean repo).
if [ "$current_fingerprint" = "$stored" ]; then
  : # silent proceed (user already saw this exact set)
elif [ -z "$stored" ] && [ -z "$hits" ]; then
  # I2: Clean repo first run — silently set sentinel, no prompt.
  # Also record agy_sensitive_acked_at for audit visibility (when was empty-scan auto-acked).
  # Fix #3: Two-line atomic Edit (both lines adjacent in schema) — prevents duplicate key.
  # Replacing only the fingerprint line while inserting ack_at inline left the original
  # empty agy_sensitive_acked_at: "" line intact below → YAML duplicate key.
  _ack_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  Edit(file_path: ".deep-review/config.yaml",
       old_string: "agy_sensitive_acked_fingerprint: \"\"\nagy_sensitive_acked_at: \"\"",
       new_string: "agy_sensitive_acked_fingerprint: \"${current_fingerprint}\"\nagy_sensitive_acked_at: \"${_ack_at}\"")
else
  # Sensitive set differs from last ack (or first ack with hits) — prompt user.
  # N6 fix: derive hits_summary_max_20 before AskUserQuestion (was orphan variable).
  hits_summary_max_20=$(printf '%s\n' "$hits" | sort -u | head -20 | sed 's|^|  - |')
  total_hits=$(printf '%s\n' "$hits" | grep -c . || true)
  if [ "$total_hits" -gt 20 ]; then
    hits_summary_max_20="${hits_summary_max_20}"$'\n'"  ... and $((total_hits - 20)) more"
  fi
  # AskUserQuestion shown BEFORE any reviewer is spawned (safe — not at synthesis).
  AskUserQuestion(
    question: "agy reviewer will walk this repository's filesystem (--add-dir). Sensitive-pattern files detected (compared against last acknowledgment): ${hits_summary_max_20}. Proceed with agy for cross-vendor review?",
    options: [
      { label: "Y — proceed and remember this fingerprint",
        description: "Updates agy_sensitive_acked_fingerprint to ${current_fingerprint}." },
      { label: "N — skip agy this run, do not persist fingerprint",
        description: "agy removed from reviewers_planned this run only; you will be re-prompted next run." }
    ]
  )
  if user_choice == "Y":
    # Fix #2: Edit tool matches LITERAL text, not regex — ".*" is not a wildcard here.
    # After the first ack the config holds a real SHA-256, so 'agy_sensitive_acked_fingerprint: ".*"'
    # never matches → subsequent acks silently fail → infinite re-prompts.
    # Fix: read the current literal values first, then construct an exact two-line atomic Edit.
    # Two-line atomic replace also eliminates the partial-update race (Fix #3 parallel).
    _ack_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    prev_fp=$(grep '^agy_sensitive_acked_fingerprint:' .deep-review/config.yaml \
              | sed -E 's/^agy_sensitive_acked_fingerprint: *"?([^"]*)"?$/\1/')
    prev_at=$(grep '^agy_sensitive_acked_at:' .deep-review/config.yaml \
              | sed -E 's/^agy_sensitive_acked_at: *"?([^"]*)"?$/\1/')
    Edit(file_path: ".deep-review/config.yaml",
         old_string: "agy_sensitive_acked_fingerprint: \"${prev_fp}\"\nagy_sensitive_acked_at: \"${prev_at}\"",
         new_string: "agy_sensitive_acked_fingerprint: \"${current_fingerprint}\"\nagy_sensitive_acked_at: \"${_ack_at}\"")
  else:
    # User declined exposure this run — set a session flag that §4 enumeration honors.
    AGY_USER_DECLINED_THIS_RUN=1
    # W-R7-6: do NOT touch agy_notified — that flag is for install hints, not ack.
fi
```

**중요 — 이 코드 블록은 runtime 동작의 문서화**. 실제 실행은 Claude Code 가 본 markdown 의 의도를 읽어 수행. `Edit(...)`, `AskUserQuestion(...)`, `user_choice` 같은 표현은 Edit tool 호출과 user prompt 결과를 의미하는 pseudocode 임.

### 4. 리뷰 실행 (Stage 3: Deep Review)

**fitness.json 주입 (있으면):**
- `.deep-review/fitness.json` 파일 확인 → `JSON.parse`로 로드
- 있으면: code-reviewer 에이전트 prompt에 추가:
  "다음은 프로젝트의 계산적 아키텍처 규칙(fitness.json)입니다. 이 규칙들은 deep-work에서 자동 검증되지만, 리뷰 시 규칙의 의도를 기준으로 설계 방향성을 평가하세요."
- 없으면: skip (에러 아님)

**Receipt health_report 주입 (있으면):**

deep-work v6.5.0+ 부터 session-receipt 는 M3 envelope-wrapped (`{schema_version: "1.0", envelope: {...}, payload: {...}}`). Reader 는 envelope detect → strict identity guard → `payload.health_report` unwrap 패턴이며, legacy (envelope 미적용) receipt 도 fall-through 로 처리한다.

- Receipt 발견 계약:
  1. deep-work canonical layout `.deep-work/<sid>/session-receipt.json` 에서 가장 최근 세션 탐색 (legacy `receipt.json` 도 동일 위치). `<sid>` 는 timestamp slug 라 lex-sort 가 곧 시간순. mindepth=2 maxdepth=2 로 검색 — deeper layout (예: deep-review v1.3.x 가 imagined 한 `.deep-work/sessions/<sid>/...`) 은 deep-work 의 실제 emit 위치가 아니므로 검색하지 않음.
  2. **Envelope 감지** — 파일이 다음 모양이면 envelope-wrapped 로 간주:
     - 최상위 `schema_version === "1.0"` AND `envelope` (object) AND `payload` 존재
     - 그러면 envelope **identity guard** 적용:
       - `envelope.producer === "deep-work"` AND `envelope.artifact_kind === "session-receipt"` AND `envelope.schema.name === "session-receipt"` (3-way) — 모두 통과해야 함 (handoff §4 round-4 lesson)
       - `envelope.payload` 가 non-null/non-array object (handoff §4 round-5/7 corrupt-payload defense)
       - 통과 → `health_report := envelope.payload.health_report`. envelope 의 `run_id` 를 `SOURCE_SESSION_RECEIPT_RUN_ID` 로 보존 (Stage 5.5 가 `--source-session-receipt <path>` 로 전달; helper 가 동일 identity 검증 후 `parent_run_id` chain).
       - 통과 못함 (foreign producer / drift / corrupt payload) → "envelope identity mismatch — skip" 경고 + 주입하지 않음 (silent legacy fall-through 금지: corrupt 가능성).
  3. **Legacy fall-through** — 파일이 envelope 모양이 **아니면** 비-envelope receipt 로 간주 → 최상위 `health_report` 객체를 그대로 사용. SOURCE_SESSION_RECEIPT_RUN_ID 는 unset (Stage 5.5 가 chain 안 함).
  4. health_report 의 `scan_commit` 과 현재 `git rev-parse HEAD` 비교.
  5. 일치 → health_report 를 code-reviewer prompt 에 추가 + `SOURCE_SESSION_RECEIPT` (path) 보존 (Stage 5.5 chain 용).
  6. 불일치 → "stale health report — skip" 경고 + 주입하지 않음.
  7. receipt 없음 → skip (에러 아님).

slice receipt (`.deep-work/<sid>/receipts/SLICE-*.json`) 도 동일 패턴이 필요한 경우 같은 envelope-aware 로직 (`producer=deep-work`, `artifact_kind=slice-receipt`) 으로 unwrap 한다. v1.4.0 에서는 slice receipt 직접 read path 가 없지만 향후 추가 시 본 패턴 미러.

**리뷰어 열거 (reviewer enumeration):**

```text
# v1.10.0 reviewer 구성 해석 (precedence). 무플래그 = 기존 동작 100% 유지.
claude_reviewer =
    none              if --no-opus            # codex-only 류
    ultracode-fanout  elif --ultracode        # 교체형 (§4 하이브리드 fan-out)
    single-opus       else                    # 기존 기본값 — 'opus' 리터럴 동일 emit (BC-3)

codex_included = ((--codex) OR (codex_plugin && node_available)) AND (NOT --no-codex)
agy_included   = (agy_cli && agy_enabled) AND (NOT --no-agy) \
                 AND [ -z "${AGY_USER_DECLINED_THIS_RUN:-}" ]   # per-run Stage 3.5 게이트 리터럴 유지 (BC-3)

# reviewers_planned 구성 (기존 소비자 호환: claude_reviewer != none 이면 목록에 'opus' 토큰 유지)
reviewers_planned =  (claude_reviewer != none ? ["opus"] : [])
                  + (codex_included ? ["codex-review","codex-adversarial"] : [])
                  + (agy_included ? ["agy"] : [])
N_planned = len(reviewers_planned)
```

**CONS-3 — 단발 N=0 가드**: 단발 `/deep-review --no-opus`(codex·agy 모두 부재)면 `N_planned = 0`. 이 경우 **리뷰어 열거 시점(환경 감지 후) 에러**로 즉시 종료: "`--no-opus`/`--codex-only` 는 codex 또는 agy 가 필요합니다 — 감지된 리뷰어가 없습니다." (루프의 §3.A 운영오류 중단과 대칭. Review Mode 라벨에 N=0 행은 두지 않는다.) **주의(SEC-CONS3-1)**: `N_planned` 는 flag/감지 기준이라 `--codex-only` 처럼 codex 가 flag 로 강제됐지만 실제 preflight 에서 실패하면 `N_planned>0` 이라도 실행 리뷰어가 0 이 될 수 있다 — 이 런타임 케이스는 Stage 4.3.1 의 `N_actual` 가드가 잡는다.

**BC-3 — 재작성 보존 의무**: 무플래그 `else` 분기는 기존처럼 `["opus"]` 를 산출하고, agy 절의 `[ -z "${AGY_USER_DECLINED_THIS_RUN:-}" ]` conjunct 는 리터럴로 유지한다(Stage 3.5 per-run decline 회귀 방지).

**중요 invariant**: `agy_enabled: false` (config opt-out) excludes agy from `reviewers_planned`, AND (per §3.3 mutation gating unchanged) it means `agy_cli=true, agy_enabled=false, codex_plugin=false` triggers **no** mutation prompt — verified by §5.5 scenario #7 (Task 16 manual dogfooding).

**유저 고지 (리뷰어 spawn 직전):**

리뷰어를 spawn하기 직전, 실행되는 리뷰어 구성(N_planned)에 따라 고지:

| N | Message |
|---|---|
| 4 | "4개 리뷰어(Opus, Codex review, Codex adversarial, agy)를 백그라운드에서 실행합니다. 완료되면 결과를 합성하여 알려드리겠습니다." |
| 3 | "3개 리뷰어(Opus, Codex review, Codex adversarial)를 백그라운드에서 실행합니다. 완료되면 결과를 합성하여 알려드리겠습니다." |
| 2 | "2개 리뷰어(<composition>)를 백그라운드에서 실행합니다. 완료되면 결과를 합성하여 알려드리겠습니다." |
| 1 | "Opus 리뷰를 백그라운드에서 실행합니다. 완료되면 결과를 알려드리겠습니다." |

**공유 reviewer payload 조립 (리뷰어 분기·spawn 이전 — 모든 Claude/agy 경로 공통):**

> 이 블록은 **리뷰어 분기 이전, 그리고 mutation/codex 자동노출(§3.0) 이전**에 **무조건** 1회 수행한다(셸 상태 비의존 — Stage 1 값은 오케스트레이터가 리터럴로 치환). 어떤 Claude/agy 리뷰어든 계획돼 있으면(single-opus·ultracode-fanout·agy) 이 블록이 산출한 `prompt_file` 을 **동일 경로**로 공통 소비한다: single-opus(Agent tool 입력 / claude bridge `--prompt-file`), agy bridge `--prompt-file`, ultracode 6 샤드. 오케스트레이터는 `<CHANGE_STATE>`/`<REVIEW_BASE_OPT>`/diff 를 **실효(post-WIP) 리뷰 대상**으로 채운다(아래 실효-타깃 규칙). 표준 `codex review`·Codex adversarial 에는 주입하지 않는다.
>
> **Finding 2/3 — 실효(post-WIP) 타깃 규칙(필수)**: payload 조립 시점에 워크트리·HEAD 상태가 Stage-1 수집 시점과 다를 수 있다 — Stage 1 (Collect) 의 WIP 커밋 UX(§2, "Codex 교차 검증을 위해 WIP 커밋을 생성할까요?")는 이 블록보다 **앞**에 위치하므로, 사용자가 옵션 A/B 를 수락했다면 이 블록이 도는 시점엔 워크트리가 이미 clean 이고 HEAD 가 WIP 커밋이다. 따라서 오케스트레이터는 다음을 **기계적으로** 적용한다:
> - **WIP 수락(옵션 A/B) → `--change-state clean` + `--review-base <REVIEW_BASE>`**(실효 변경셋 = `review_base..HEAD`). 이 경우 Stage-1 의 원래 `change_state`(예: `mixed`)를 쓰면 `git diff HEAD` 가 빈/stale → **성공했지만 빈 manifest**(무경고)로 리뷰어가 change_files 를 통째로 잃는다(spec §3.2 silent-empty). 그래서 `mixed`/`staged`/`unstaged` 가 아니라 `clean`+`review_base..HEAD` 로 채운다.
> - **WIP 거부(옵션 C) 또는 WIP UX 미발생 → Stage-1 `change_state` 그대로**(dirty 워크트리가 곧 리뷰 대상).
> codex 자동노출(`git add -f -N`, §3.0)도 이 블록 **이후**여야 한다(노출이 먼저면 dirty 상태가 오염됨).

```bash
# 오케스트레이터가 Stage 1 파싱값을 리터럴로 채운다 (예: --change-state staged).
PR="${CLAUDE_PLUGIN_ROOT}"; P="$PR/hooks/scripts"
repoDir="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
warnings=""
doc=$(mktemp); cf=$(mktemp); ctx_file=$(mktemp); diff_file=$(mktemp); prompt_file=$(mktemp); manual_files_z=$(mktemp)

# (오케스트레이터가 이 블록 안에서) diff → $diff_file, 세션/비-git 타겟(NUL) → $manual_files_z,
# rules.yaml/contract/fitness.json/health_report(있으면) → $ctx_file 를 채운다.
# diff 는 위 "실효(post-WIP) 타깃 규칙"과 동일한 범위를 써야 change_files 와 일치한다:
#   WIP 수락 → `git diff <REVIEW_BASE>..HEAD` (= review_base..HEAD), WIP 거부/미발생 → Stage-1 상태별 diff.

if ! bash "$P/extract-fp-doctrine.sh" "$PR/skills/deep-review-workflow/references/review-criteria.md" > "$doc" 2>/dev/null; then
  : > "$doc"; warnings="${warnings}fp-doctrine extraction failed (injection skipped); "
fi
# <CHANGE_STATE>/<REVIEW_BASE> 는 오케스트레이터가 Stage 1 값으로 치환하는 리터럴.
if ! bash "$P/build-change-files.sh" --repo "$repoDir" --change-state <CHANGE_STATE> \
        <REVIEW_BASE_OPT> --files-from-z "$manual_files_z" > "$cf" 2>/dev/null; then
  : > "$cf"; warnings="${warnings}change_files unavailable (omitted); "
fi
bash "$P/build-reviewer-payload.sh" --doctrine-file "$doc" --change-files-file "$cf" \
     --context-file "$ctx_file" --diff-file "$diff_file" > "$prompt_file"
printf 'PROMPT_FILE=%s\n' "$prompt_file"   # 오케스트레이터가 캡처
printf 'OCR_WARNINGS=%s\n' "$warnings"     # → Stage 4 Summary.Warnings (verdict 불변)
```

(`<CHANGE_STATE>` = **실효(post-WIP) 리뷰 대상 상태**를 리터럴로 — 1차 규칙: Stage-1 에서 WIP 커밋이 수락됐으면 `clean`, 아니면 Stage-1 `change_state`. `<REVIEW_BASE_OPT>` = 실효 상태가 clean 일 때만 `--review-base <REVIEW_BASE>` 두 토큰(WIP 수락 시 = `review_base..HEAD`), **비-clean 이면 토큰 자체를 생략** — 빈 문자열 `""` 인자를 넘기지 말 것(build-change-files 가 unknown-arg 로 exit 2 → change_files 누락).) 이후 단계는 캡처한 `PROMPT_FILE` **리터럴 경로**를 쓴다 — Agent tool 은 그 파일 내용을, agy/claude bridge 는 `--prompt-file '<PROMPT_FILE literal>'` 로(셸 변수 `$PROMPT_FILE` 의존 금지 — 다음 Bash 호출엔 그 변수가 없다). diff 가 맨 뒤인 것은 **지시-우선(instruction-attention) 순서**일 뿐이며 agy 절단 생존 보장이 아니다(절단되면 agy 는 prompt_too_large 로 제외).

**Claude 쪽 리뷰어 — `claude_reviewer` 값에 따라 분기 (§4 리뷰어 열거):**

- `single-opus` (기본) → 아래 "Claude Opus reviewer" 단일 Opus 경로(Agent tool / CLI bridge) 그대로.
- `ultracode-fanout` (`--ultracode`) → `references/ultracode-integration.md` 의 하이브리드 fan-out 을 수행한다(6 차원 샤드 → 단일 "Claude(ultracode)" 보이스). **순서 계약(ARCH-1)**: 먼저 codex/agy 백그라운드 잡을 spawn 한 뒤 ultracode 를 호출하고, Stage 4 진입 전 ultracode 결과 + 모든 codex/agy 완료를 join 한다. ultracode 보이스는 `reviewers_planned` 의 단일 'opus' entry 를 대체한다. **아래 "Claude Opus reviewer" 블록은 수행하지 않는다.**
- `none` (`--no-opus`/`--codex-only`) → Claude 리뷰어 미spawn. **아래 "Claude Opus reviewer" 블록은 수행하지 않는다.** (단발 N=0 은 §4 CONS-3 가드 + Stage 4.3.1 N_actual 가드에서 차단.)

**Claude Opus reviewer (`claude_reviewer == single-opus` 일 때만):**

> 이 블록은 `claude_reviewer == single-opus` 인 경우에만 적용한다. `ultracode-fanout` 은 위 분기대로 `ultracode-integration.md` 를 따르고, `none` 은 Claude 리뷰어를 건너뛴다.

single-opus 경로는 **위 "공유 reviewer payload 조립" 블록이 캡처한 `PROMPT_FILE`** 을 그대로 소비한다(별도 조립 없음) — Agent tool 은 그 리터럴 경로의 파일 내용을 프롬프트로 읽고, claude bridge 는 `--prompt-file '<captured PROMPT_FILE literal>'` 로 전달한다. 표준 `codex review`·Codex adversarial 에는 그 payload 를 주입하지 않는다.

1. **Claude Code 런타임 (`Agent` tool 사용 가능)**:
   - 캡처한 `PROMPT_FILE` 리터럴 경로의 파일 내용을 읽어 Agent tool 프롬프트로 사용한다.
   - Agent tool로 `code-reviewer` 에이전트를 백그라운드에서 spawn:
     - `model: "opus"` (config.yaml의 review_model로 오버라이드 가능)
     - `run_in_background: true`
   - 이 경로가 기존 Claude Code `/deep-review`의 기본 경로다.
2. **Codex / non-Claude 런타임 (`Agent` tool 없음)**:
   - `claude_cli=true`이면 Bash로 CLI bridge를 백그라운드 실행:
     ```bash
     output_file=$(mktemp "${TMPDIR:-/tmp}/deep-review-claude-output.XXXXXX")
     "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/run-claude-reviewer.sh" \
       --project-root "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" \
       --plugin-root "${CLAUDE_PLUGIN_ROOT}" \
       --prompt-file '<captured PROMPT_FILE literal>' \
       --output "$output_file" \
       --model "${review_model:-opus}"
     ```
   - helper는 내부적으로 `claude -p --plugin-dir "$CLAUDE_PLUGIN_ROOT" --agent code-reviewer --model opus`를 호출한다.
   - Codex의 `spawn_agent` / sub-agent로 대체하지 않는다. 그 경로는 Claude reviewer가 아니라 Codex reviewer가 되므로 3-way 구성의 독립성이 깨진다.
   - `claude_cli=false` 또는 helper exit 127이면 Claude reviewer를 `not_attempted: claude_cli_unavailable`로 표시하고, 나머지 성공한 리뷰어만으로 N-way 합성을 진행한다.

**Codex preflight (codex_plugin=true일 때):**
1. `codex_plugin=true AND node_available=false` 조합 → 사용자 안내: "Codex companion 은 감지되었으나 Node.js 가 PATH 에 없어 호출 불가. `brew install node` 등으로 설치 필요." 이후 Opus 단독 진행.
2. codex:review를 시도하기 전에 Codex가 실제로 동작하는지 확인
3. 실패 시 (인증 오류, 타임아웃 등): Codex 결과를 "미수행"으로 표시하고 Claude Opus 단독으로 fallback
4. 합성 시 미수행 리뷰어는 제외 (3-way가 아닌 실제 수행된 리뷰어 수 기준)

**agy preflight (agy가 reviewers_planned에 포함된 경우):**
```bash
# C4: _timeout shim MUST be defined inline at the start of every Bash block that uses it.
# Each Bash tool call is a separate subshell — functions defined in prior calls are invisible.
_timeout() {
  local seconds="$1"; shift
  if command -v gtimeout >/dev/null 2>&1; then gtimeout "$seconds" "$@"; return; fi
  if command -v timeout  >/dev/null 2>&1; then  timeout  "$seconds" "$@"; return; fi
  # BLOCKER-1 fix: shift $seconds BEFORE fork so child's @ARGV is the actual command.
  # fork first; exec only in child. Parent traps SIGALRM, exits 124.
  perl -e '
    my $seconds = shift @ARGV;
    my $pid = fork;
    if (!defined $pid) { die "fork: $!" }
    if (!$pid) { exec @ARGV; die "exec: $!" }
    alarm $seconds;
    $SIG{ALRM} = sub { kill 15, $pid; exit 124 };
    wait;
    exit ($? >> 8)
  ' "$seconds" "$@"
}
# agy preflight (W-R5-1 / W-R7-1 fix: use $agy_cli_path for deterministic binding, NOT literal `agy`).
_timeout 10 "$agy_cli_path" --version >/dev/null 2>&1 && AGY_PREFLIGHT=OK || AGY_PREFLIGHT=FAIL
if [ "$AGY_PREFLIGHT" = "FAIL" ]; then
  AGY_STATUS="not_attempted:agy_preflight_failed"
  # Remove agy from reviewers_planned, recompute N_planned
fi
```

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
   - `MUTATION_OK=0` → Codex 호출 skip, Opus 만 spawn.

**Mutation-failure fallback (C-R7-4 / spec §4.4 update — per-reviewer label)**

`acquire_mutation_lock` 또는 `git add -f -N` 실패 시 (CR3 graceful fallback):

- **codex** 는 git-visible files 만으로 호출 (노출된 gitignored 파일 access 불가)
- **agy 는 영향 없음** — `--add-dir` filesystem walk 은 mutation 무관 (§3.3 / §4.5 trust-boundary 참조)

Summary 가 `Review Mode: {N}-way — codex visible-only / agy full-tree, mutation failed` 라고 표시 → 사용자가 리포트만 봐도 agy 의 coverage 가 변하지 않고 codex 만 degrade 됐음을 인지.

**F3 — Codex 인증 실패 구분 (stderr 캡처)**:

각 Codex 호출 Bash 블록에 stderr 캡처 + 패턴 매칭 추가:
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
  _timeout 900 node "{codex_companion_path}" review {codex_target_flag}
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
    && cat > "$focus_file" <<'"'"'FOCUS_EOF_deepreview'"'"'
  {focus_text}
  FOCUS_EOF_deepreview
  _timeout 900 node "{codex_companion_path}" adversarial-review {codex_target_flag} - < "$focus_file"
  rc=$?; rm -f "$focus_file"; exit $rc
  ', run_in_background: true })
  ```

  here-doc delimiter `FOCUS_EOF_deepreview` 는 focus_text 본문에 포함되지 않도록 충분히 unique하게 선택한다. focus_text 안에 해당 문자열이 있을 가능성이 있으면 UUID/해시를 붙여 동적으로 생성한다.

  **대안 (Option B — 리터럴 경로 캡처)**: 한 Bash 호출에서 mktemp 후 stdout으로 경로를 출력하고, LLM이 그 경로를 리터럴 문자열로 받아 후속 `Write` / `Bash` 호출에 붙여 넣는다. 변수 전개를 사용하지 않으므로 안전하지만, 호출 체인이 길다.

  1. `Bash({ command: 'f=$(mktemp "${TMPDIR:-/tmp}/deep-review-focus.XXXXXX") && chmod 600 "$f" && echo "$f"' })` → stdout에서 리터럴 경로 `<PATH>` 획득
  2. `Write({ file_path: "<PATH>", content: focus_text })`  (변수 아님, 실제 경로)
  3. `Bash({ command: '_timeout 900 node "{codex_companion_path}" adversarial-review {codex_target_flag} - < "<PATH>"', run_in_background: true })`
  4. 완료 알림 수신 후 `Bash({ command: 'rm -f "<PATH>"' })`로 정리

  **금지 사항**:
  - 호출 1에서 `focus_file=$(mktemp …)` 로 변수만 만들고 후속 Bash에서 `$focus_file` 참조 → **subshell 경계 넘지 못해 unset**. 절대 사용 금지.
  - `trap 'rm -f "$focus_file"' EXIT` 을 호출 1에 등록 → 호출 1의 EXIT가 즉시 발생해 background 호출 2가 파일을 읽기 전에 선제 삭제. Option A 내부에서만 trap을 사용한다.
  - `/tmp/deep-review-focus.txt` 같은 predictable name 사용 → race/symlink 공격.

4. **agy reviewer** (Bash tool, run_in_background: true)

  > **공유 PROMPT_FILE 소비 (필수 — Finding 1/2 #2 doctrine 도달)**: agy 의 `{prompt_file}` 은
  > **위 "공유 reviewer payload 조립" 블록이 캡처한 `PROMPT_FILE` 리터럴 경로 바로 그것**이다 —
  > single-opus(Agent tool 입력 / claude bridge `--prompt-file`)와 ultracode 6 샤드가 소비하는
  > **동일한 하나의 파일**. agy 전용으로 새 `mktemp` 를 만들지 **않는다**. 그 payload 에는
  > fp-doctrine(거짓양성 독트린)과 change_files manifest 가 이미 들어 있으므로, agy 를 이 공유
  > PROMPT_FILE 로 구동해야 v1.12.0 의 #2(독트린·변경셋이 모든 리뷰어에 도달) 가 agy 에도 성립한다.
  > **금지**: payload 없는 prompt(독트린/change_files 누락)를 agy 에 넘기는 것 — agy 만 빠진 #2 가 됨.
  >
  > **Read-only 강제 (v1.8.1)**: agy CLI 는 read-only 모드가 없다 (`-p` 가 권한 플래그
  > 유무와 무관하게 Edit/Write 를 자동 승인 — 실측 확인). `run-agy-reviewer.sh` 가
  > **이 공유 PROMPT_FILE 본문 앞에** read-only preamble 을 **무조건 prepend** 하므로(payload 는
  > 그대로 유지), orchestrator 는 위 블록이 캡처한 `PROMPT_FILE` 을 그대로 넘기기만 하면 된다 —
  > read-only 지시를 직접 넣을 필요 없다. 이렇게 해야 agy 가 합성(Stage 4) 전에 코드를 수정하지 않는다.
  > 자세한 rationale 은 `skills/deep-review-workflow/references/agy-integration.md` 참조.

  > **LLM substitution note**: `{placeholder}` values (e.g. `{agy_cli_path}`, `{prompt_file}`,
  > `{output_file}`) are substituted with **literal strings** by the orchestrator (LLM) before
  > invoking the Bash tool. They are NOT shell variables — the spawned subshell has no memory of
  > prior Bash calls or LLM-side state. Use Stage 1 detection output (`agy_cli_path`) and mktemp
  > outputs from earlier in this session as the literal values to substitute.

  **Concrete substitution example** (orchestrator fills before invoking Bash):
  - `{agy_cli_path}` → `/usr/local/bin/agy` (from Stage 1 `agy_cli_path` detection)
  - `{project_root}` → `/home/user/myrepo` (from `git rev-parse --show-toplevel`)
  - `{prompt_file}` → **the captured `PROMPT_FILE` literal path from the "공유 reviewer payload 조립" block above** (e.g. `/tmp/tmp.xXxXxX` — the SAME file single-opus and the ultracode shards consume, NOT a fresh agy-only mktemp; it already carries fp-doctrine + change_files). `run-agy-reviewer.sh` prepends the read-only preamble on top of this shared payload.
  - `{output_file}` → `/tmp/deep-review-agy-output.xXxXxX` (from a fresh mktemp in an earlier Bash call — agy's output sink is per-reviewer, unlike the shared input prompt)

  > Note: `agy_model` is NOT a `{placeholder}` — it is free-form text from (possibly untrusted) config and is resolved as a shell variable inside the bridge-invocation Bash call (see "model tier" below), so it can never be literal-substituted into the command string.

  **v1.7.1 mode resolution** (orchestrator owns the chain, then passes resolved value as `--mode`):

  ```bash
  # Order: AGY_FINGERPRINT_MODE env var > .deep-review/config.yaml field > built-in default 'hybrid'
  agy_fingerprint_mode="${AGY_FINGERPRINT_MODE:-}"
  if [ -z "$agy_fingerprint_mode" ] && [ -f .deep-review/config.yaml ]; then
    agy_fingerprint_mode=$(sed -nE 's/^agy_fingerprint_mode:[[:space:]]*["'\'']?([^"'\''#[:space:]]+)["'\'']?.*$/\1/p' .deep-review/config.yaml | head -1)
  fi
  agy_fingerprint_mode="${agy_fingerprint_mode:-hybrid}"
  case "$agy_fingerprint_mode" in
    hybrid|full-walk|git-status|off) ;;
    *)
      echo "⚠️ Invalid agy_fingerprint_mode '$agy_fingerprint_mode' — falling back to 'hybrid'" >&2
      agy_fingerprint_mode=hybrid
      ;;
  esac
  ```

  **v1.9.0 model tier — resolve IN-SHELL inside the bridge invocation (injection-safe).**

  > ⚠️ **보안 (shell injection 방지)**: `agy_model` 은 `.deep-review/config.yaml` / `AGY_MODEL` 에서 오는 **free-form 문자열**이고, 신뢰할 수 없는 repo 가 `.deep-review/config.yaml` 을 commit 해 ship 할 수 있다. enum 으로 검증되는 `--mode` 와 달리 model 은 자유 문자열이므로, **LLM 이 이 값을 `{placeholder}` 리터럴로 Bash 명령 문자열에 치환하면 shell injection** 이 된다 (예: `agy_model: '"; rm -rf ~ ; #'`). 따라서 model 은 **반드시 bridge 호출과 같은 Bash 세션 안에서 shell 변수로 해석**하고 `--model "$agy_model"` 로 **변수 전개**한다 — 절대 `{agy_model}` 리터럴로 치환하지 않는다. 1차 방어로 charset allowlist 가드를 둔다. (이는 codex focus_text 를 stdin 으로만 넘기는 §위 패턴과 동일한 원칙이다.)

  agy 4번째 reviewer 는 **이 전체 블록을 하나의 `Bash({ command: '...', run_in_background: true })` 호출**로 실행한다 — 다른 reviewer(Opus/Codex)와 동일한 background 실행 계약이며, 한 Bash 호출 = 한 shell 이므로 `agy_model` / `agy_model_args` 의 변수 scope 가 bridge invocation 과 일치한다. `{agy_cli_path}` / `{project_root}` / `{prompt_file}` / `{output_file}` / `{agy_fingerprint_mode}` 만 리터럴 치환 (신뢰된 detection/mktemp/enum 값 — 특히 `{prompt_file}` = 위 "공유 reviewer payload 조립" 블록이 캡처한 `PROMPT_FILE`, single-opus/ultracode 와 **동일한** mktemp 산 경로); `agy_model` 은 **절대 리터럴 치환하지 않고** shell 변수로만 전개한다.

  ```
  Bash({ command: '
  # --- agy model tier: env > config > default, resolved IN-SHELL (never literal-substituted) ---
  # Default "Gemini 3.5 Flash (High)": review is a bounded read task, so a Flash tier
  # cuts the dominant agy cost (Gemini inference round-trip) vs the Pro default.
  # Config value may be double-quoted OR an unquoted scalar. (A single-quoted YAML
  # value is intentionally NOT parsed here — it trips the charset guard below and
  # falls back to the default with a warning; quote with " or leave unquoted.)
  agy_model="${AGY_MODEL:-}"
  if [ -z "${AGY_MODEL:-}" ]; then
    if [ -f .deep-review/config.yaml ] && grep -qE "^agy_model:" .deep-review/config.yaml; then
      raw=$(grep -E "^agy_model:" .deep-review/config.yaml | head -1 | sed -E "s/^agy_model:[[:space:]]*//")
      case "$raw" in
        \"*) agy_model=${raw#\"}; agy_model=${agy_model%%\"*} ;;                            # double-quoted
        *)   agy_model=${raw%%#*}; agy_model="${agy_model%"${agy_model##*[![:space:]]}"}" ;;  # unquoted scalar (Opus #2)
      esac
    else
      agy_model="Gemini 3.5 Flash (High)"
    fi
  fi
  # charset allowlist (injection defense + garbage guard): letters digits space . _ - ( ) /
  case "$agy_model" in
    "") : ;;
    *[!A-Za-z0-9\ ._/\(\)-]*) echo "WARN agy_model has unsupported characters - using built-in default" >&2; agy_model="Gemini 3.5 Flash (High)" ;;
  esac
  # Build argv so an empty model omits --model entirely (set -u-safe empty-array form).
  agy_model_args=(); [ -n "$agy_model" ] && agy_model_args=(--model "$agy_model")
  "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/run-agy-reviewer.sh" \
    --binary "{agy_cli_path}" \
    --project-root "{project_root}" \
    --prompt-file "{prompt_file}" \
    --output "{output_file}" \
    --mode "{agy_fingerprint_mode}" \
    ${agy_model_args[@]+"${agy_model_args[@]}"} \
    --timeout-seconds 900
  ', run_in_background: true })
  ```

  Orchestrator passes `--binary {agy_cli_path}` (Stage 1 detection result) for deterministic binding independent of subsequent `$PATH` mutations. Bridge's internal resolution (`--binary` → `$AGY_BINARY` → `command -v agy`) only activates if `--binary` was not passed (e.g., direct CLI tests).

  Orchestrator passes `--mode {agy_fingerprint_mode}` (resolved chain above). The env-var slot (`AGY_FINGERPRINT_MODE`) lets CI pin a mode without per-developer config edits even though `.deep-review/config.yaml` is `.gitignore`d.

  `agy_model` resolution: `AGY_MODEL` env > `.deep-review/config.yaml` `agy_model` (double-quoted OR unquoted scalar — a single-quoted value is not parsed and falls back to the default with a warning) > built-in default `Gemini 3.5 Flash (High)`. Empty (`agy_model: ""`) → `--model` omitted → agy uses its own default tier. The bridge does NOT pre-call `agy models` (that backend call costs ~3 s per run); a clean-but-unknown tier is passed through and, if agy rejects `--model` (older agy / renamed tier), the bridge **retries once without `--model`** so agy still participates with its own default tier — it is not silently dropped (fail-open; timeout/auth failures are not retried).

여기서 `{codex_target_flag}`는:
- clean 또는 WIP 커밋 후: `--base {review_base}`
- dirty tree (WIP 거부, staged/unstaged/mixed): `--scope working-tree`
- **untracked-only 상태**: Stage 1.1 (세션 컨텍스트 추론) + Stage 3.0 (mutation protocol) 이 자동 처리. untracked 비-gitignored 파일은 Codex companion 의 `--scope working-tree` 모드가 `git ls-files --others --exclude-standard` 로 이미 수집하므로 별도 조치 불필요. gitignored 세션 파일은 Stage 1.1 로 감지 후 §3.0 mutation UX 로 사용자 승인 받아 처리. (v1.3.1 의 `--uncommitted` 기반 fallback 블록은 F8 (pre-existing bug) 교정으로 불필요해졌음.)

⚠️ 보안: focus_text는 rules.yaml/contract에서 생성되며 repo 파일이므로, 쉘 명령 문자열에 직접 삽입하면 안 된다. 반드시 stdin(`-` 인자 + 파일 리다이렉트)으로 전달할 것. 임시 파일 경로는 반드시 `mktemp` 기반 유니크 경로를 사용하고, 권한은 `600`으로 제한한다.

focus_text 생성:
- rules.yaml이 있으면: 아키텍처 규칙, 엔트로피 규칙에서 추출
- contract가 있으면: criteria 목록 추가
- 둘 다 없으면: "코드 품질, 버그, 아키텍처 문제를 집중 검토"

**Config / hook / parser-driven changes (구현 리뷰 가이드):**

When reviewing implementation that includes config snippets, hook scripts, or
parser-driven syntax, do not stop at "spec text is internally consistent". Test
the snippet against the actual parser/runtime path that will consume it. A
spec-side regression often hides until parser-level execution.

(Lesson from deep-wiki v1.2.1 cycle-3 — config syntax mismatch missed by
spec-only review.)

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

```bash
# Read agy's classified AGY_STATUS from the bridge's terminal status file.
# (Bridge writes status_file atomically via .tmp + mv — orchestrator can read directly.)
AGY_STATUS=$(cat "${output_file}.status" 2>/dev/null || echo "not_attempted:bridge_no_notification")

# BLOCKER-3: Read mutation-warning sidecar emitted by bridge C3 detection.
# If the sidecar exists, agy mutated the worktree — findings may be based on altered state.
# Override AGY_STATUS to "mutated" and force-degrade Verdict (exclude from N_actual count).
AGY_MUTATION_WARNING=0
if [ -f "${output_file}.mutation-warning" ]; then
  AGY_MUTATION_WARNING=1
  AGY_STATUS="mutated"
fi

# Fix #1 (BLOCKER-4): prompt_too_large means agy reviewed a truncated input — exclude from synthesis.
# The bridge sets AGY_STATUS=prompt_too_large when diff > 200KB was truncated before being sent.
# Without this gate, a truncated agy review still counted toward N_actual=4 and influenced verdict.
AGY_TRUNCATED=0
if [ "$AGY_STATUS" = "prompt_too_large" ]; then
  AGY_TRUNCATED=1
fi

# Combined synthesis exclusion gate — replaces the prose-only AGY_MUTATION_WARNING rule below.
# Any of these conditions means agy's output is unreliable and must NOT count toward N_actual.
AGY_EXCLUDE_FROM_SYNTHESIS=0
[ "$AGY_MUTATION_WARNING" = "1" ] && AGY_EXCLUDE_FROM_SYNTHESIS=1
[ "$AGY_TRUNCATED"        = "1" ] && AGY_EXCLUDE_FROM_SYNTHESIS=1
[ "$AGY_STATUS"          != "success" ] && AGY_EXCLUDE_FROM_SYNTHESIS=1
# When AGY_EXCLUDE_FROM_SYNTHESIS=1:
#   - Exclude agy from N_actual (do NOT count its output as a valid reviewer).
#   - Inject reason-specific warning into Summary (see conditions above for per-reason text).
#   - Do NOT promote agy findings into verdict — treat agy as "not_attempted" for synthesis purposes.
```

> **Synthesis rule (AGY_EXCLUDE_FROM_SYNTHESIS=1)**:
> - Exclude agy from `N_actual` (do NOT count its output as a valid reviewer).
> - Per-condition Summary warnings:
>   - `AGY_MUTATION_WARNING=1`: `⚠️ agy mutated workspace — manually verify before trusting review output`; append `git status`.
>   - `AGY_TRUNCATED=1` (prompt_too_large): `⚠️ agy reviewed a truncated diff (>200KB) — findings may be incomplete`.
>   - Other non-success `AGY_STATUS`: `⚠️ agy did not complete successfully (status: ${AGY_STATUS}) — excluded from synthesis`.
> - Do NOT promote agy findings into verdict — treat agy as "not_attempted" for synthesis purposes.

> **OCR_WARNINGS render step (payload-helper warnings → Summary)**: 공유 payload 조립 블록이 캡처한 `OCR_WARNINGS` 문자열을 Summary 의 `Warnings:` 줄에 그대로 렌더링한다(세미콜론 구분 항목; 0건이면 줄 자체를 생략). 이는 helper 실패 진단(fp-doctrine/change_files 누락) 고지일 뿐 **verdict 는 불변** — agy 의 `AGY_EXCLUDE_FROM_SYNTHESIS` 경고와 달리 `N_actual` 에 영향을 주지 않는다. Warnings 줄의 단일 출처 정의는 `references/report-format.md`.

1. 교차 검증 합성 (Codex 결과가 있을 때):
   - 전원 일치 지적 → 🔴 높은 확신
   - 2/3 지적 → 🟡 중간 확신
   - 단독 지적 → 참고
   - 전원 통과 → 🟢

**4-way verdict synthesis (when N_actual=4)**:

| N_actual | Pattern | Verdict | Per-finding annotation |
|---|---|---|---|
| 4 | 4/4 agree | 🔴 high → REQUEST_CHANGES | `agreement: unanimous_4` |
| 4 | 3/4 agree | 🔴 high | `agreement: majority_3_of_4` + `dissenter: <name>` + `dissenter_family: anthropic\|openai\|google` + `dissent_summary` |
| 4 | 2/4 agree | 🟡 CONCERN | `agreement: split_2_of_4` (supporters + dissenters listed) |
| 4 | 1/4 sole | info (single-reviewer note) | `agreement: solo_1_of_4` + `source: <reviewer>` |
| 4 | 0/4 | 🟢 APPROVE | n/a |

기존 N=3, 2, 1 fallback 행은 그대로 유지 (3-way 이하).

2. Verdict 결정:
   - 🔴 1건 이상 → **REQUEST_CHANGES**
   - 🟡만, 전원 일치 → **REQUEST_CHANGES**
   - 🟡만, 의견 분리 → **CONCERN**
   - 🟢만 → **APPROVE**

### Stage 4.3.1: opus 실패 시 auto-degradation (no AskUserQuestion at synthesis)

`opus_status != success AND N_actual_external ≤ 1` (= Opus 실패 + 외부 reviewer 1개 이하 성공) 시:

1. **합성과 리포트 저장은 항상 진행** (Verdict 강등하더라도 결과 보존).
2. **Verdict 를 `CONCERN` 으로 강제** (APPROVE 또는 REQUEST_CHANGES 금지).
3. **Summary 어노테이션**: `degraded: opus_failed_low_confidence` + 실행된 reviewer 목록.
4. **`last_review` 평소처럼 update**.
5. **사후 chat 메시지**: "⚠️ Verdict downgraded to CONCERN — Opus failed and only {N} external reviewer(s) responded. Treat findings as advisory."

이는 deterministic — synthesis 단계에서 AskUserQuestion 없음. (R5 C-R5 / R7 §4.3.1 fix — async run_in_background 패러다임과 충돌 회피.)

**N_actual == 0 런타임 가드 (SPEC-3 / SEC-CONS3-1):** `claude_reviewer == none`(`--no-opus`/`--codex-only`) 인데 실제로 완료된 외부 reviewer 가 0개(codex/agy 가 전부 미설치·인증실패·timeout·실패)면 — `N_planned` 는 flag/감지 기준이라 통과했더라도 — **빈 리포트로 APPROVE/CONCERN 을 내지 말고** CONS-3 식 운영 에러로 중단한다: "리뷰어가 0개 실행됨 — codex/agy 가 필요하지만 실행에 실패했습니다. 인증/설치를 확인하세요." (parse·열거 시점의 `N_planned` 가드(§4 CONS-3)와 달리, 본 가드는 preflight 이후 **실제 실행 결과**(`N_actual`) 기준이다.)

**ultracode 단일 보이스 & `opus_status` collapse (CONS-10):** `claude_reviewer = ultracode-fanout` 이면 6 샤드 findings 를 `ultracode-integration.md §4` 규칙으로 1건의 "Claude(ultracode)" 보이스로 collapse 한 뒤 cross-model N-way 매트릭스에 **Anthropic 한 표**로 넣는다(샤드 개별 투표 금지). degraded-mode 마커가 의존하는 `opus_status` 는 샤드 성공 수 K 를 **disjoint quorum 밴드**(우선순위 failed→partial→success)로 collapse 한다: **`failed` iff K=0; `partial` iff 1 ≤ K < 쿼럼(=4); `success` iff K ≥ 쿼럼(=4).** 따라서 degraded 마커(`opus_status != success`)는 **K<4 (쿼럼 미달)** 일 때 발동한다(단일 Opus 와 동등 이상 안전성 유지). 정의 단일 출처는 `ultracode-integration.md §2(B)`.

**Review Mode 라벨(v1.10.0):**
- `--ultracode` + codex: `{N}-way Cross-Model — Claude=ultracode(6-lens, verified) + Codex 2-way`
- `--ultracode` 단독: `1-way — Claude=ultracode(6-lens) only`
- `--no-opus`/`--codex-only`: `1-way (codex-only)` / `2-way (codex-only + agy)` / `1-way (agy only)`
- 폴백: `… Claude=ultracode(agent-fanout fallback, Workflow unavailable)` 또는 `(UNVERIFIED fallback)`
상세 표는 `references/report-format.md`.

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

4. **Payload 합성 → envelope wrap → atomic write** (M3 Phase 2 envelope adoption, v1.4.0+):

   먼저 위 분류 결과를 *payload* JSON 으로 임시 파일에 기록한다 (구조는 v1.3.x 와 동일 — envelope 으로 감쌀 뿐):

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

   그 다음 `hooks/scripts/wrap-recurring-findings-envelope.js` 가 envelope wrap + atomic temp+rename 으로 최종 위치 (`.deep-review/recurring-findings.json`) 에 emit 한다. 이 helper 는 zero-dep, plugin module 경로 기반 (literal-cwd-resolve), `fs.renameSync` 원자 교체이므로 mid-write 중단이나 동시 실행에도 truncated JSON 을 만들지 않는다.

   **chain 의무 (handoff §3.3 mirror)**: §3 Receipt health_report 주입 단계에서 발견된 deep-work session-receipt 가 envelope-wrapped 라면 그 `envelope.run_id` 를 `--source-session-receipt <path>` 로 helper 에 전달한다 — helper 가 strict 3-way identity check (producer=deep-work, artifact_kind=session-receipt, schema.name match) 후 `parent_run_id` 로 자동 chain. legacy session-receipt 또는 foreign envelope 이면 path 만 source_artifacts 에 들어가고 chain 은 set 되지 않는다.

   **Bash snippet** (markdown agent prompt — self-contained: Bash tool 호출 간 env var 이 persist 되지 않으므로 stage 간 변수 공유 가정 금지. session-receipt 경로는 본 snippet 안에서 재탐색 — deep-evolve round-1 C1 / round-2 R2-3 교훈):

   ```bash
   set -euo pipefail
   PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
   WRAP_HELPER="${CLAUDE_PLUGIN_ROOT:?CLAUDE_PLUGIN_ROOT not set}/hooks/scripts/wrap-recurring-findings-envelope.js"
   OUTPUT_PATH="$PROJECT_ROOT/.deep-review/recurring-findings.json"
   PAYLOAD_TMP="$PROJECT_ROOT/.deep-review/.tmp-recurring-payload.$$.$RANDOM.json"

   mkdir -p "$PROJECT_ROOT/.deep-review"

   # 위 분류 단계가 PAYLOAD_TMP 에 다음 shape 의 JSON 을 기록했다고 가정:
   #   { "updated_at": "...", "taxonomy_version": "1.0", "findings": [...] }
   # (LLM 일괄 분류 결과를 jq 또는 직접 JSON 파일 작성)

   # parent_run_id chain — 본 snippet 안에서 deep-work session-receipt 재탐색.
   # SOURCE_SESSION_RECEIPT 환경변수로 caller override 가능 (있으면 우선).
   # 없으면 deep-work canonical layout `.deep-work/<sid>/session-receipt.json`
   # 의 가장 최근 파일을 자동 선택 (sid = timestamp slug, lex-sortable).
   # mindepth=2 maxdepth=2 — `.deep-work/<sid>/<file>` 만 매치, deep-review
   # imagined `.deep-work/sessions/<sid>/...` 같은 깊은 layout 은 의도적 제외
   # (Codex Round-1 Q4 lesson — sessions/ prefix 가 lex-sort 에서 timestamp 보다
   # 우선시 되어 잘못된 source 를 픽하던 회귀; helper 의 strict 3-way identity
   # guard 가 차단하므로 정확성 영향은 없었지만 UX 측면 fix).
   #
   # awk 'NR==1' 사용 (head -1 대신) — set -o pipefail 하에서 head 의 early-close 가
   # 상류 sort 로 SIGPIPE (exit 141) 를 보내 pipeline 을 abort 시키는 것을 회피
   # (Codex Round-1 Q5 lesson; macOS bash 3.2 에서 재현 확인됨).
   SESSION_RECEIPT="${SOURCE_SESSION_RECEIPT:-}"
   if [ -z "$SESSION_RECEIPT" ] && [ -d "$PROJECT_ROOT/.deep-work" ]; then
     SESSION_RECEIPT=$(find "$PROJECT_ROOT/.deep-work" -mindepth 2 -maxdepth 2 \
       \( -name 'session-receipt.json' -o -name 'receipt.json' \) -type f 2>/dev/null \
       | sort -r | awk 'NR==1')
   fi

   WRAP_ARGS=(--payload-file "$PAYLOAD_TMP" --output "$OUTPUT_PATH")
   if [ -n "$SESSION_RECEIPT" ] && [ -f "$SESSION_RECEIPT" ]; then
     WRAP_ARGS+=(--source-session-receipt "$SESSION_RECEIPT")
   fi

   # Multi-source 추적 — review report markdown 들도 source_artifacts 에 기록
   # (path-only; envelope detect 안 됨 → run_id 없음). 최근 N=20 개로 제한해
   # source_artifacts 폭증 방지. while-read 루프 + awk 'NR<=20' 사용 — head 의
   # SIGPIPE 와 IFS subshell expansion 을 모두 회피 (bash 3.2 호환).
   shopt -s nullglob
   reports=("$PROJECT_ROOT"/.deep-review/reports/*.md)
   shopt -u nullglob
   if [ ${#reports[@]} -gt 0 ]; then
     while IFS= read -r r; do
       WRAP_ARGS+=(--source-artifact "$r")
     done < <(printf '%s\n' "${reports[@]}" | sort -r | awk 'NR<=20')
   fi

   # Gated cleanup: helper 성공 시에만 PAYLOAD_TMP 제거. 실패 시 보존 → 재실행 가능
   # (deep-work round-1 C2 lesson — 이전 버전은 unconditional rm 으로 silent loss 발생).
   if node "$WRAP_HELPER" "${WRAP_ARGS[@]}"; then
     rm -f "$PAYLOAD_TMP"
   else
     echo "[deep-review/Stage5.5] wrap-recurring-findings-envelope.js failed — payload preserved at $PAYLOAD_TMP for retry" >&2
     exit 1
   fi
   ```


   결과 파일 모양 (envelope shape — 자세한 명세는 `claude-deep-suite/docs/envelope-migration.md` §1):

   ```json
   {
     "$schema": "https://raw.githubusercontent.com/Sungmin-Cho/claude-deep-suite/main/schemas/artifact-envelope.schema.json",
     "schema_version": "1.0",
     "envelope": {
       "producer": "deep-review",
       "producer_version": "<plugin.json.version>",
       "artifact_kind": "recurring-findings",
       "run_id": "<ULID>",
       "parent_run_id": "<consumed session-receipt run_id, optional>",
       "generated_at": "<RFC 3339>",
       "schema": { "name": "recurring-findings", "version": "1.0" },
       "git": { "head": "<sha>", "branch": "<name>", "dirty": false },
       "provenance": {
         "source_artifacts": [
           { "path": ".deep-work/.../session-receipt.json", "run_id": "<sess run_id>" },
           { "path": ".deep-review/reports/<ts>-review.md" }
         ],
         "tool_versions": { "node": "<version>" }
       }
     },
     "payload": {
       "updated_at": "<ISO 8601>",
       "taxonomy_version": "1.0",
       "findings": [/* 위와 동일 */]
     }
   }
   ```

5. 이 파일은 deep-evolve init Stage 3.5 + deep-work `gather-signals.sh` 가 envelope-aware 로 소비한다 (forward-compat unwrap — payload.findings 추출). legacy (pre-1.4.0) recurring-findings.json 도 양쪽 consumer 가 fall-through 로 그대로 처리.

6. **자체 검증 (선택)** — release lint 또는 dev workflow 에서 emit 결과를 검증하려면:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-envelope-emit.js" .deep-review/recurring-findings.json
   ```

   이 validator 는 suite repo 의 `artifact-envelope.schema.json` 을 zero-dep 로 mirror 한다 (additionalProperties:false, ULID/SemVer 2.0.0/RFC 3339 정규식, identity check). plugin self-test (`tests/envelope-emit.test.js` + `tests/envelope-chain.test.js`) 가 동일 패턴을 자동 실행.

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

# Phase 6 tmp artifact 1단계 회전 — 직전 세션은 prev/로 보존, 2회 이전은 자동 소멸.
# v1.3.4 N2 교정: .log 외에도 TSV (C4) + baseline/ (W4/C5) 디렉토리를 함께 회전.
mkdir -p .deep-review/tmp/prev
if compgen -G ".deep-review/tmp/phase6-*.log" > /dev/null 2>&1; then
  rm -f .deep-review/tmp/prev/phase6-*.log 2>/dev/null || true
  mv .deep-review/tmp/phase6-*.log .deep-review/tmp/prev/ 2>/dev/null || true
fi
if compgen -G ".deep-review/tmp/phase6-*.tsv" > /dev/null 2>&1; then
  rm -f .deep-review/tmp/prev/phase6-*.tsv 2>/dev/null || true
  mv .deep-review/tmp/phase6-*.tsv .deep-review/tmp/prev/ 2>/dev/null || true
fi
if compgen -G ".deep-review/tmp/phase6-*-baseline" > /dev/null 2>&1; then
  rm -rf .deep-review/tmp/prev/phase6-*-baseline 2>/dev/null || true
  mv .deep-review/tmp/phase6-*-baseline .deep-review/tmp/prev/ 2>/dev/null || true
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

Phase 6 구현은 `phase6-implementer` 서브에이전트에 그룹 dispatch. 상세 스펙: `skills/receiving-review/references/phase6-delegation-spec.md` §3, §5, §6.

**심각도 그룹 loop** (🔴 → 🟡 → ℹ️):

**실행 가능한 e2e 테스트**: 아래 각 Step의 핵심 shell 로직은 `hooks/scripts/test/test-phase6-protocol-e2e.sh`의 12개 테스트(E1~E12)에서 실증 검증됨. pseudocode가 문서로 drift하지 않도록 **CI에서 e2e도 함께 실행**.

**Step ↔ spec 매핑** (단일 mental map 유지용):

| Commands Step | Spec 섹션 | 역할 |
|---|---|---|
| 1. Skip (0건) | §6.1 | 엣지 케이스 |
| 2. 로그 경로 | §5.4 (preamble) | prelim |
| 3. Pre-dispatch snapshot | §5.4.1 | allowlist + baseline |
| 4. Dispatch (2단계 fallback) | §5.4.2 (dispatch 부분) | agent 호출 |
| 5. 결과 검증 | §5.4.2~§5.4.7 | 파싱·DELTA·violation·claim·REVERTED·log |
| 6. 그룹 커밋 | §5.4.8 | pathspec-limited 커밋 |
| 7. Dirty recovery | §5.4.9 | per-file baseline 복원 |
| 8. 중단 판정 | §6.3 | 후속 그룹 dispatch 차단 |
| (본 Steps 외) Response 리포트 | §5.4.10 | commands §3 "Response 리포트 저장" |
| (본 Steps 외) PR 코멘트 게시 | §5.4.11 | `--source=pr` 경로 |

1. 해당 그룹의 ACCEPT 항목이 0건이면 skip.
2. 로그 경로 결정: `log_path="$(pwd)/.deep-review/tmp/phase6-${severity}.log"` (절대 경로). `mkdir -p .deep-review/tmp`.
3. **Pre-dispatch snapshot** (spec §5.4.1) — allowlist + content-aware baseline:
   ```bash
   # Allowlist = target_location 경로 union modifiable_paths (스펙 §5.1 계약)
   # TARGET_LOCATIONS_OF_GROUP, MODIFIABLE_PATHS_OF_GROUP = Accepted Items 파싱 결과
   # target_location은 "src/a.ts:45-60" 형식 또는 comma-separated 다중 경로 허용 — line-range strip
   ALLOWED=$(printf '%s\n' "${TARGET_LOCATIONS_OF_GROUP[@]}" "${MODIFIABLE_PATHS_OF_GROUP[@]}" \
     | tr ',' '\n' \
     | sed -E 's/:[0-9][0-9,\-]*\s*$//; s/^[[:space:]]+//; s/[[:space:]]+$//' \
     | sort -u | sed '/^$/d')

   # Path set baseline (violation 검출용)
   # --name-status -M: rename(R)/copy(C) 감지 시 new path를 채택 (E7 검증).
   # **staged + unstaged 합집합** — `git mv`는 자동 staged이므로 `--cached` 없이는 감지 불가.
   # subagent는 Bash tool을 보유해 임의 시점에 rename을 staged 상태로 둘 수 있으므로
   # 두 diff를 모두 스캔해야 trust boundary가 성립한다 (v1.3.4 review C1 교정).
   # Binary 파일은 --name-status도 경로 단위로 나열되며 DELTA는 아래
   # `git hash-object`(binary 대응 가능)로 계산되므로 별도 분기 없음 (E8 검증).
   PRE_MODIFIED=$( { git -c core.quotepath=false diff --name-status -M;
                     git -c core.quotepath=false diff --cached --name-status -M; } \
     | awk -F'\t' '
         $1 ~ /^[RC]/ { print $3; next }
         $1 != "" { print $2 }
       ' | sort -u)
   PRE_UNTRACKED=$(git -c core.quotepath=false ls-files --others --exclude-standard | sort -u)
   PRE_STATUS=$(git -c core.quotepath=false status --porcelain=v1 -uall)

   # Content snapshot — ALLOWED 각 파일에 대해 per-file 복사 (Dirty recovery 용)
   # v1.3.4 review C4 교정: bash 3.2 호환을 위해 associative array 대신 TSV temp file 사용
   # (macOS 기본 `/bin/bash` 3.2 에서 `declare -A` 는 invalid option).
   mkdir -p ".deep-review/tmp/phase6-${severity}-baseline"
   PRE_HASH_FILE=".deep-review/tmp/phase6-${severity}-pre-hash.tsv"
   PRE_TRACKED_FILE=".deep-review/tmp/phase6-${severity}-pre-tracked.tsv"  # C5 교정
   : > "$PRE_HASH_FILE"
   : > "$PRE_TRACKED_FILE"
   while IFS= read -r f; do
     [[ -z "$f" ]] && continue
     # C5 교정: "worktree 존재 ≠ tracked 여부". git ls-files 로 명시적 구분.
     if git ls-files --error-unmatch -- "$f" >/dev/null 2>&1; then
       tracked="true"
     else
       tracked="false"
     fi
     printf '%s\t%s\n' "$f" "$tracked" >> "$PRE_TRACKED_FILE"

     if [[ -f "$f" ]]; then
       printf '%s\t%s\n' "$f" "$(git hash-object -- "$f")" >> "$PRE_HASH_FILE"
       # per-file baseline copy (preserves user WIP content)
       mkdir -p ".deep-review/tmp/phase6-${severity}-baseline/$(dirname "$f")"
       cp -p "$f" ".deep-review/tmp/phase6-${severity}-baseline/$f"
     else
       printf '%s\tabsent\n' "$f" >> "$PRE_HASH_FILE"
     fi
   done <<< "$ALLOWED"

   # W7 교정: ALLOWED 각 경로의 pre-existing staged hunk 여부 기록.
   # Recovery 시 git restore --staged 가 사용자 partial-hunk staging 을 un-stage 하므로
   # 해당 경로 목록을 미리 확보해 warning + response.md 복원 로그에 활용.
   PRE_STAGED_FILE=".deep-review/tmp/phase6-${severity}-pre-staged.tsv"
   : > "$PRE_STAGED_FILE"
   while IFS= read -r f; do
     [[ -z "$f" ]] && continue
     if git diff --cached --quiet -- "$f" 2>/dev/null; then
       printf '%s\tfalse\n' "$f" >> "$PRE_STAGED_FILE"
     else
       printf '%s\ttrue\n' "$f" >> "$PRE_STAGED_FILE"
     fi
   done <<< "$ALLOWED"

   # Pre-existing outside hash snapshot (C3 교정: allowlist bypass via pre-dirty files).
   # PRE_MODIFIED ∪ PRE_UNTRACKED 중 ALLOWED 에 없는 경로의 content hash 를 기록.
   # Subagent 가 "이미 dirty 였던 non-ALLOWED 경로"를 추가 수정하면 POST 에서 hash
   # 차이로 감지해 VIOLATIONS 에 포함시킨다 (path-membership 만으로는 놓치는 케이스).
   PRE_OUTSIDE_HASH_FILE=".deep-review/tmp/phase6-${severity}-pre-outside-hash.tsv"
   : > "$PRE_OUTSIDE_HASH_FILE"
   PRE_ALL=$(printf '%s\n%s\n' "$PRE_MODIFIED" "$PRE_UNTRACKED" | sort -u | sed '/^$/d')
   while IFS= read -r f; do
     [[ -z "$f" ]] && continue
     # ALLOWED 에 이미 있으면 skip — DELTA 로직이 관장
     grep -Fxq "$f" <<< "$ALLOWED" && continue
     if [[ -f "$f" ]]; then
       printf '%s\t%s\n' "$f" "$(git hash-object -- "$f")" >> "$PRE_OUTSIDE_HASH_FILE"
     else
       printf '%s\tabsent\n' "$f" >> "$PRE_OUTSIDE_HASH_FILE"
     fi
   done <<< "$PRE_ALL"
   ```
4. **Dispatch 2단계 네임스페이스 fallback** (spec §5.4.2 dispatch):
   - 환경변수 `DEEP_REVIEW_FORCE_FALLBACK=1` 이 설정되면 dispatch 건너뛰고 즉시 main fallback 경로로 분기 (단, baseline 보존 상태).
   - 1차: `Agent({ subagent_type: "deep-review:phase6-implementer", prompt: <§5.1 계약> })`
   - 1차가 "subagent_type not found" 또는 유사 에러 반환 시 2차: `Agent({ subagent_type: "phase6-implementer", prompt: <§5.1 계약> })`
   - 2차도 실패 또는 permission refusal 등 dispatch 자체 실패 시 → main fallback 분기.
5. **결과 검증 (dispatch 성공 시) — fail-closed + content-aware delta + allowlist** (spec §5.4.2~§5.4.7):
   - 반환 메시지에 `## Group Result` 블록이 **없거나 파싱 불가능**하면 dispatch 실패로 재분류 → Step 7 "Dirty recovery"로 분기.
   - **Content-aware DELTA** (E2 검증): ALLOWED 각 경로의 hash를 post-dispatch와 비교. content 변경된 경로만 포함:
     ```bash
     # bash 3.2 호환: associative array 대신 TSV file iterate (C4)
     DELTA=()
     while IFS=$'\t' read -r f pre_hash; do
       [[ -z "$f" ]] && continue
       post=$([[ -f "$f" ]] && git hash-object -- "$f" || echo "absent")
       [[ "$post" != "$pre_hash" ]] && DELTA+=("$f")
     done < "$PRE_HASH_FILE"
     ```
   - **Path-set violation** — ALLOWED 외부 경로가 수정/생성됐는지 별도 체크 (trust boundary):
     ```bash
     # PRE와 동일한 --name-status -M 정규화 (rename/copy → new path)
     # staged + unstaged 합집합 (C1 교정 — `git mv`는 staged-only로 나타남)
     POST_MODIFIED=$( { git -c core.quotepath=false diff --name-status -M;
                        git -c core.quotepath=false diff --cached --name-status -M; } \
       | awk -F'\t' '
           $1 ~ /^[RC]/ { print $3; next }
           $1 != "" { print $2 }
         ' | sort -u)
     POST_UNTRACKED=$(git -c core.quotepath=false ls-files --others --exclude-standard | sort -u)
     NEW_PATHS=$(printf '%s\n%s\n' \
       "$(comm -13 <(echo "$PRE_MODIFIED") <(echo "$POST_MODIFIED"))" \
       "$(comm -13 <(echo "$PRE_UNTRACKED") <(echo "$POST_UNTRACKED"))" \
       | sort -u | sed '/^$/d')
     VIOLATIONS=$(comm -23 <(echo "$NEW_PATHS") <(echo "$ALLOWED"))
     [[ -n "$VIOLATIONS" ]] && { execution_status=error; error_reason="outside allowlist: $VIOLATIONS"; }

     # C3 교정: pre-existing outside path content 변경 검사 (E9 검증)
     # path-membership 만으로는 "이미 dirty 였던 non-ALLOWED 경로 재수정" 을 못 잡는다.
     # bash 3.2 호환: associative array 대신 TSV file iterate (C4)
     OUTSIDE_VIOLATIONS=()
     while IFS=$'\t' read -r f pre_hash; do
       [[ -z "$f" ]] && continue
       post=$([[ -f "$f" ]] && git hash-object -- "$f" || echo "absent")
       [[ "$post" != "$pre_hash" ]] && OUTSIDE_VIOLATIONS+=("$f")
     done < "$PRE_OUTSIDE_HASH_FILE"
     if [[ ${#OUTSIDE_VIOLATIONS[@]} -gt 0 ]]; then
       execution_status=error
       error_reason="pre-existing outside paths mutated by subagent: ${OUTSIDE_VIOLATIONS[*]}"
     fi
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
6. **그룹 커밋 — pathspec-limited** (spec §5.4.8): 전원 PASS AND Step 5 검증 통과 시에만:
   - 빈 배열 가드: `[[ ${#CHANGED_FILES[@]} -eq 0 ]]`면 이상 상태 → `execution_status=error`.
   - **Untracked 신규 파일 명시적 add** (NUL-safe, E5-adjacent):
     ```bash
     # bash 3.2 호환: PRE_HASH_FILE TSV lookup (C4)
     while IFS= read -r f; do
       [[ -z "$f" ]] && continue
       pre_hash=$(awk -F'\t' -v p="$f" '$1 == p { print $2; exit }' "$PRE_HASH_FILE")
       # 신규 untracked 파일 (PRE에 없었음) 에만 git add
       if [[ -z "$pre_hash" || "$pre_hash" == "absent" ]]; then
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
       echo "⚠ Phase 6 범위 외에 pre-staged 파일이 감지됐습니다:"
       git -c core.quotepath=false diff --cached --name-only -- . "${EXCL[@]}" || true
       echo "→ 이 파일들은 인덱스에 staged로 남지만 이 커밋에는 포함되지 않습니다 (git commit --only 의미론)."
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
       echo "⚠ CHANGED_FILES 내 파일에 pre-staged hunk가 있습니다 — auto-commit에 pre-staged 변경과 Phase 6 수정이 함께 포함됩니다:"
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
7. **Dirty recovery — per-file content baseline** (spec §5.4.9, E5 검증):
   - `git status --porcelain=v1 -uall` 로 POST_STATUS 수집, `PRE_STATUS != POST_STATUS` 이면 dirty 상태 남음.
   - AskUserQuestion:
     > "서브에이전트가 dirty 상태로 중단됐습니다. 어떻게 할까요?
     > (1) 유지하고 main 계속 (partial edits 위에 쌓음 — 권장 안 함)
     > (2) baseline으로 restore (**per-file content snapshot 사용** — 사용자 WIP 보존)
     > (3) 중단, 사용자 수동 판단"
   - (2) 선택 시 — **`git restore --source=HEAD` 사용 금지** (pre-existing WIP 파괴). 대신 Step 3에서 저장한 per-file baseline 과 tracking-state 로 **worktree + index 양쪽**을 PRE 상태로 복원 (W4/C5 교정: subagent 가 `git add`/`git mv`/`git rm` 로 index 를 건드렸을 수 있고, PRE 상태가 "untracked" 와 "tracked-but-deleted" 두 가지가 있음 — 구분 필수):
     ```bash
     # W7 교정: Phase 6 진입 전부터 staged hunk 가 있던 ALLOWED 경로를 사용자에게 경고.
     # git restore --staged 는 partial-hunk staging state 까지 un-stage 하므로.
     PRE_STAGED_ALLOWED=()
     while IFS=$'\t' read -r f had_staged; do
       [[ -z "$f" ]] && continue
       [[ "$had_staged" == "true" ]] && PRE_STAGED_ALLOWED+=("$f")
     done < "$PRE_STAGED_FILE"
     if [[ ${#PRE_STAGED_ALLOWED[@]} -gt 0 ]]; then
       echo "⚠ 다음 ALLOWED 경로는 Phase 6 진입 전부터 staged hunk 가 있었습니다 — recovery 시 git restore --staged 로 함께 un-stage 됩니다:"
       printf '  %s\n' "${PRE_STAGED_ALLOWED[@]}"
       echo "→ response.md 복원 로그에 기록. 복구하려면 'git add' 또는 'git add -p' 로 재-stage 하세요."
     fi

     # bash 3.2 호환: PRE_TRACKED_FILE TSV iterate (C4)
     # C5 교정: PRE 의 "tracked 여부" 에 따라 index 복원 분기.
     while IFS=$'\t' read -r f pre_tracked; do
       [[ -z "$f" ]] && continue

       if [[ "$pre_tracked" == "true" ]]; then
         # tracked 였던 경로: index 를 HEAD 상태로 되돌림 (subagent 의 git add/rm 무효화).
         # PRE 가 "unstaged delete" 여도 이 후 worktree rm 으로 같은 상태 재구성.
         git restore --staged -- "$f" 2>/dev/null || true
       else
         # untracked 였던 경로: subagent 가 add 한 경우 index 에서 제거.
         git rm --cached --ignore-unmatch -- "$f" >/dev/null 2>&1 || true
       fi

       # 이어서 worktree 복원
       baseline=".deep-review/tmp/phase6-${severity}-baseline/$f"
       if [[ -f "$baseline" ]]; then
         mkdir -p "$(dirname "$f")"
         cp -p "$baseline" "$f"
       else
         # baseline 없음 = PRE 에 worktree 파일이 없었음.
         # 두 가지 경우: (a) tracked-but-deleted WIP, (b) untracked-absent.
         # 둘 다 "worktree 에 파일이 없는 상태" 가 원본이므로 현재 worktree 파일 제거.
         [[ -f "$f" ]] && rm -f "$f"
       fi
     done < "$PRE_TRACKED_FILE"
     ```
     - **주의 (W7)**: `git restore --staged` 는 사용자가 Phase 6 진입 전 `git add -p` 등으로 만든 partial-hunk staging state 도 함께 un-stage 한다. `$PRE_STAGED_ALLOWED` 목록으로 사전에 경고하고 response.md 에 기록하므로 사용자가 `git add -p` 를 재실행해 복구 가능. 완전한 staged-blob 단위 복원은 v1.3.5 후보 (W7 full snapshot).
   - (3) 선택 시 response.md에 현재 상태 snapshot 기록 후 종료.
8. **중단 판정** (spec §6.3 참고): `execution_status in (halted_on_regression, error)` 또는 `items_failed > 0`이면 다음 그룹 dispatch 안 함. 스킵된 후속 항목은 `decision: DEFER, defer_reason: "halted at {severity} group"`로 기록.

**Main fallback 분기** (dispatch 실패):

1. 경고 출력: `⚠ phase6-implementer dispatch 실패 ({reason}). 세션 내 fallback 실행으로 전환합니다.`
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
agy_notified: false
agy_enabled: true
agy_sensitive_acked_fingerprint: ""
agy_sensitive_acked_at: ""
agy_fingerprint_mode: hybrid
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
