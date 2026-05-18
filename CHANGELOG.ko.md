# 변경 기록

[English](./CHANGELOG.md) | **한국어**

## [1.6.1] — 2026-05-18 (Codex-native plugin manifest and AGENTS guide)

### 추가

- **`.codex-plugin/plugin.json`** — Claude Code manifest 와 동일한 skill/hook 표면을 가리키는 Codex 네이티브 플러그인 manifest. 기존 `claude-deep-*` repository identity 는 유지.
- **`AGENTS.md`** — Codex 프로젝트 가이드. runtime surface, 검증 명령, downstream suite marketplace 갱신 요구사항을 명시.

### 변경

- patch release 로 package/plugin manifest 버전을 1.6.0 → 1.6.1 로 동기화.
- README 문서에 기존 Claude Code 표면과 함께 Codex 호환성을 명시.

### 검증

- 릴리스 전 repository 검증을 실행. 정확한 명령 출력은 PR 체크리스트 참조.

## [1.6.0] — 2026-05-16 (`/deep-review-loop` 커맨드 → user-invocable 스킬)

### 변경 — `/deep-review-loop` 가 슬래시 커맨드에서 `user-invocable: true` 스킬로 이전

v1.5.0 에서 슬래시 커맨드 (`commands/deep-review-loop.md`) 로 ship 된 리뷰↔대응 자동 반복 wrapper `/deep-review-loop` 가 스킬 (`skills/deep-review-loop/SKILL.md`) 로 마이그레이션. 목적은 **Codex / SDK / Claude Code 외 플랫폼과의 진입 표준화** — 슬래시 커맨드는 Claude Code 한정인 반면, 스킬은 Claude Code / Codex CLI / Copilot CLI / Gemini CLI / Agent SDK 모두가 이해하는 공통 invocation surface 다. 본 변경 이후 loop 은 어디서든 `Skill({ skill: "deep-review:deep-review-loop", args: "..." })` 로 호출 가능하며, Claude Code 에서는 기존 `/deep-review-loop` 진입도 그대로 동작한다 (`user-invocable: true` 스킬은 슬래시 진입을 자동 노출).

- **동작 변경: 없음.** §0 ~ §9 프로토콜 — argument 사전 검증, 라운드 본체 (Review → 조건부 Respond → Metrics), 라운드 식별 set-difference invariant, Respond 경로 realpath 가드, `findings_signature` 정체 ≥ 50% 감지, 운영 오류 ≥ 2 hard stop, 자연 수렴 (`APPROVE` + 🔴/🟡=0), `--max` 안전장치 (기본 5; Review 호출만 카운트) — 모두 그대로 이전. 문구 차이는 self-reference 의 "wrapper / 커맨드" → "skill" 과 신규 `## Invocation` 섹션 (슬래시 진입과 `Skill(...)` 진입을 명시) 두 가지뿐.
- **Frontmatter 이전**: 커맨드 전용 `allowed-tools` + `argument-hint` 제거. 신규 스킬 frontmatter: `name: deep-review-loop`, `description: Use when ...` (스킬 가이드에 따라 3인칭 + triggering-conditions only), `user-invocable: true`.
- **`commands/deep-review-loop.md`** 삭제. **`skills/deep-review-loop/SKILL.md`** 신규. **`commands/deep-review.md`** 첫머리 링크가 스킬 경로 (`../skills/deep-review-loop/SKILL.md`) 로 조정되고 슬래시/`Skill(...)` 두 진입을 모두 명시.
- **`CLAUDE.md`** 디렉토리 트리 업데이트 (`commands/` 는 단일 파일, `skills/deep-review-loop/` 추가). "Slash commands" 표는 "Slash commands & user-invocable skills" 로 개명, `Kind` 컬럼이 추가되어 커맨드 행과 신규 skill 행을 구분.
- **`README.md` / `README.ko.md`** 행은 dual entry (`/deep-review-loop` 슬래시 = Claude Code, `Skill({ skill: ... })` = 그 외) 를 설명하도록 수정.

### 왜 지금

v1.5.0 구현은 이미 슬래시-to-슬래시 dispatch 가 portable 하지 않다는 사실을 인지하고 `commands/deep-review.md` 를 `Read` 해 인라인 수행하도록 설계되어 있었다 (즉, 커맨드 본문에 의존하긴 하지만 커맨드 dispatch 자체에는 의존하지 않음). 따라서 커맨드 진입을 고수해야 할 invariant 는 사실상 없었고, 스킬로 승격하는 것이 자연스러운 종착점이다. Codex 마이그레이션 준비, 그리고 향후 Agent-SDK 기반 harness 가 deep-review 를 감싸는 모든 시나리오에서 `Skill(...)` 단일 진입을 활용할 수 있다.

### 버전

- `.claude-plugin/plugin.json` 1.5.1 → 1.6.0.
- `package.json` 1.5.1 → 1.6.0.

## [1.5.1] — 2026-05-13 (스킬 문서 drift 정리 — plugin-dev audit follow-up)

### 수정 — v1.5.0 릴리스와 실제 shipped 산출물 간 문서 drift 정리

v1.5.0 릴리스 직후 `plugin-dev:plugin-validator` + `plugin-dev:skill-reviewer` audit 으로 스킬/스펙 문서와 실제 shipped 산출물 간 7개 drift 항목이 발견되었다. 본 patch 는 이를 모두 해결하며, 커맨드/스크립트/훅 프로토콜/런타임 동작 변경은 없다.

- **`agents/code-reviewer.md`, `agents/phase6-implementer.md`** — 비표준 `whenToUse` frontmatter 필드 제거 (Claude Code agent 스키마에 없는 필드라 silently ignore 되고 있었음). "직접 호출 금지" 안내는 기존 `description` block scalar 에 흡수.
- **`skills/deep-review-workflow/SKILL.md`**:
  - Stage 5 dangling cross-reference 정리 — `(Stage 5)` 라벨이 `(/deep-review --respond 모드, Stage 5+ 참조)` 로 변경되고, 새 `## Stage 5+ (커맨드 레벨 확장)` 섹션이 stages 5 / 5.5 / 6 / 7 의 위치(=`commands/deep-review.md`)를 명시.
  - Codex Mutation Protocol 섹션에 `*왜 필요한가*` 설명 단락 추가 (Codex CLI 는 git-tracked 경로만 인식 → gitignored 세션 파일 노출에 intent-to-add mutation + 사후 복원 필요).
  - Stage 3 Case 3 의 inline `(v1.3.x …)` changelog 브레드크럼 트림 — 기술적 사실은 유지하고 버전 태그만 제거 (CHANGELOG 에 속함, spec 에 속하지 않음).
- **`skills/receiving-review/SKILL.md`** — `references/phase6-delegation-spec.md` (Phase 6 dispatch 설계 스펙) 가 "참조 문서" 리스트에 1줄 purpose 와 함께 추가되어 SKILL 로딩 시 발견 가능.
- **`skills/receiving-review/references/response-protocol.md`** — Phase 6 "구현 규칙 — 그룹 dispatch" 가 35줄의 중복 shell 로직 (sed/awk/git commit --only 세부) 에서 single-source-of-truth 표 + 7개 invariant 요약으로 축소. shell 로직의 정식 단일 소스는 `commands/deep-review.md` `--respond` Step 2.5; 중복은 drift 위험을 만들었음. Re-review 제안 블록도 `SKILL.md "Re-review 제안"` 포인터로 교체.
- **`skills/receiving-review/references/phase6-delegation-spec.md`** — Status `Draft (브레인스토밍 합의 반영)` → `Shipped (v1.3.3+, revised through v1.5.0)`; 날짜 dual-stamp `2026-04-24 (initial), revised 2026-05-13`. 임베디드 YAML frontmatter 예제도 shipped shape (no `whenToUse`) 로 sync 하고 v1.3.3 → v1.5.1 schema convergence 를 설명하는 migration note 추가.

검증: `plugin-dev:plugin-validator` + `plugin-dev:skill-reviewer` 재실행 결과 PASS, 신규 경고/에러 0건.

### 버전

- `.claude-plugin/plugin.json` 1.5.0 → 1.5.1.
- `package.json` 1.5.0 → 1.5.1.

## [1.5.0] — 2026-05-13

### 추가 — `/deep-review-loop` wrapper 커맨드

`/deep-review` (리뷰) 와 `/deep-review --respond` (대응) 을 같은 세션에서 자동 반복하는 신규 슬래시 커맨드 `/deep-review-loop`. 메인 에이전트가 더 이상의 반복이 무의미하다고 판단할 때까지 라운드를 이어간다.

- **Argument**: `--contract [SLICE-NNN]` / `--entropy` 는 매 라운드 review 단계로 그대로 전달. `--max=N` 은 안전장치 (기본 5; **단위 = Review 호출 횟수**, Respond 는 카운터를 증가시키지 않음). loop 의미와 충돌하는 `--respond` / `init` / `--qa` 는 거부.
- **종료 정책**: 고정 횟수가 아니라 메인 에이전트의 종합 판단. (a) 자연 수렴 (`verdict=APPROVE` AND 🔴/🟡=0), (b) `--max` 도달, (c) **수렴 정체** — 직전 라운드와 동일한 `findings_signature` 집합 (`severity:file:line±3:taxonomy_category`) 이 50% 이상 재출현 + `implemented_count=0` 또는 `halted=true`, (d) 한 라운드 안에서 운영 오류(mutation 복원 실패, lock 점유 등) 누적 ≥ 2, (e) 사용자가 가드 단계에서 중단 선택, 중 하나라도 충족되면 즉시 중단. 계속 진행하려면 verdict 가 `REQUEST_CHANGES`/`CONCERN` AND 직전 라운드에서 실제 변경 발생 AND `findings_signature` 가 유의미하게 변화해야 한다.
- **구현**: wrapper 는 별도 상태 파일을 만들지 않고, `commands/deep-review.md` 본문을 1회 `Read` 한 뒤 그 안의 "리뷰 모드" / "대응 모드" 섹션을 매 라운드 인라인 수행. 라운드 메트릭은 세션 메모리에만 있고, 최종 요약은 `.deep-review/responses/{YYYY-MM-DD}-{HHmmss}-loop-summary.md` 로 저장 (기존 `.gitignore` 정책상 untracked).

활용: `/deep-review` 받고 `REQUEST_CHANGES` 떨어지면 `/deep-review --respond` 돌리고 다시 `/deep-review` 로 검증하는 흐름을 한 커맨드로 묶어 자동 수렴.

### 변경 — Codex per-call timeout 300s → 900s (15분)

- `commands/deep-review.md` (4개 호출 지점: §3 stderr probe, review, adversarial-review Option A, Option B step 3).
- `skills/deep-review-workflow/SKILL.md` Stage 3 Case 3 (review + adversarial-review).
- `skills/deep-review-workflow/references/codex-integration.md` §Preflight Step 3, §3-way (review + adversarial-review), §Codex 인증 실패 처리.
- CHANGELOG 의 historical `timeout 300` 언급은 시점 사실로 보존.

이유: 대형 diff, rate-limit, 재시도 등으로 300s 가 자주 미달되어 유효한 3-way 리뷰가 `CODEX_STATUS=timeout` 으로 1-way 로 강등되는 사례가 반복. 900s 로 상향해 안전장치는 유지하되 false-positive timeout 을 제거. shim 의미론(gtimeout → timeout → perl alarm fallback) 은 변경 없음.

### 변경 — `REVIEW_TIMEOUT_SECONDS` 600s → 1200s (mutation lock orphan window)

`hooks/scripts/mutation-protocol.sh:43` — `status=committed` lock 의 mid-review orphan 감지 임계를 600s (10분) → 1200s (20분) 으로 상향. 새 `_timeout 900` 가 한 Codex 호출당 최대 900s 까지 lock 을 정당하게 점유할 수 있는데, 600s 임계는 동시 세션의 `auto_recover` 가 진행 중 reviewer 의 lock 을 orphan 으로 오판해 intent-to-add 항목을 회수하는 race 를 만들었음. 1200s = 900s + 300s (합성/I-O 마진). 세션별 override 는 `export REVIEW_TIMEOUT_SECONDS=N`.

### 버전

- `.claude-plugin/plugin.json` 1.4.2 → 1.5.0.
- `package.json` 1.4.2 → 1.5.0 (이전 릴리스 정책대로 플러그인 매니페스트와 동기화).

## [1.4.2] — 2026-05-12 (M5.5 #5 follow-up — cross-platform `stat` 순서 수정)

### 수정 — `mutation-protocol.sh` BSD-first `stat -f %m` 순서가 ubuntu에서 깨짐

수정 전 `acquire_mutation_lock()` / `auto_recover()` 의 lock mtime 해결:

```bash
lock_mtime=$(stat -f %m "$LOCK_DIR" 2>/dev/null || stat -c %Y "$LOCK_DIR" 2>/dev/null || echo 0)
```

순서가 잘못됨: GNU `stat -f`는 **수락**됨 (Linux에서는 "filesystem status" 의미). `%m`는 mount-point **문자열** (예: `/`)을 반환. fallback `||`는 절대 실행되지 않음. 다음 줄 `age=$((now - lock_mtime))`는 `/`가 숫자 operand이 아니므로 arithmetic 문법 오류 → `set -e` exit.

bash 테스트(`test-mutation-protocol.sh`)가 M5.5 #5 (PR #11) 이전에는 CI에서 실행된 적이 없어 잠재. v1.4.1에서 CI step을 임시 비활성화로 우회했고, 이번 조사로 표면화.

**수정**: stat 순서를 reverse — GNU `-c %Y` 먼저, BSD `-f %m` fallback. deep-work PR #27 `test-v6.4.2-regression.sh` §2 BSD/GNU `stat` reverse-order 패턴 미러.

### 변경

- `hooks/scripts/mutation-protocol.sh` line 65, 253 — 두 호출점 수정 + 순서 contract 명시 코멘트.
- `.github/workflows/tests.yml` — v1.4.1에서 우회를 위해 비활성화했던 `bash hooks/scripts/test/test-mutation-protocol.sh` CI step 재활성화. ubuntu/macOS 양쪽 모두 mutation-protocol 전체 회귀를 실행.
- `.claude-plugin/plugin.json` + `package.json` version: 1.4.1 → 1.4.2.

### 조사 과정

debug 브랜치 (`debug/ubuntu-mutation-protocol-trace`, PR #12)에서 모든 테스트 전환 지점과 `assert_failure()` 내부에 `>>> MARK` 트레이스 라인을 추가하여 root cause 식별. 트레이스 결과 exit이 `assert_failure: pre-eval`과 `post-eval` 사이 — 즉 두 번째 호출(lock 이미 보유 상태)의 내부 `eval "acquire_mutation_lock"` 안에서 발생함을 확인. 이로써 acquire_mutation_lock의 fallback-stat 블록으로 범위 축소 → `-f %m` cross-platform 의미 차이 발견.

## [1.4.1] — 2026-05-12

### 추가 — M5.5 #5 mutation-lock stale-recovery 통합 테스트

`hooks/scripts/test/test-mutation-protocol.sh` 에 3 개 신규 케이스 (Test 26 / 27 / 28) 추가. 기존 Test 12 (stale state, lock 없음) + Test 10 (restore_mutation user-staging 필터) 가 다루지 못한 **통합 시나리오** — 잔여 `.deep-review/.mutation.lock` + `.pending-mutation.json` + 별도 흐름에서 추가된 사용자 staging 의 동시 공존 — 을 검증한다. 다섯 가지 계약 속성을 동시에 핀한다: (1) orphan-lock 감지, (2) lock 해제, (3) 우리의 i-t-a 제거, (4) **사용자 staging 보존**, (5) state-file 정리. (4) 만 깨지고 나머지가 통과하는 단일 회귀는 기존 스위트로는 잡히지 않는다.

- Test 26 (M5.5 #5-A): 단일 사용자 staging 파일 + crashed mutation → 복구 + 보존.
- Test 27 (M5.5 #5-B): state file 없을 때 defensive no-op (legitimate staging 박탈 방지).
- Test 28 (M5.5 #5-C): 3 개 사용자 staging 파일 모두 복구 후 살아남음 (i-t-a 필터의 off-by-one 회귀 가드).

총 단언 수: 51 → 54 (+3). 프로덕션 코드 변경 없음 — 테스트 전용 PR.

### 변경

- `.claude-plugin/plugin.json` version: 1.4.0 → 1.4.1 (테스트 전용 patch).

### 노트

- Bash 회귀 테스트 (`test-mutation-protocol.sh`) 는 macOS 에서는 로컬 실행하지만 ubuntu CI 통합은 follow-up 으로 보류. `tests.yml` 에 bash 단계를 추가해 본 초기 시도가 tests 5 → 6 사이에서 pre-existing ubuntu 특화 실패를 노출 — M5.5 #5 추가와는 무관 (macOS bash 3.2 는 깔끔하게 통과). 잠재 버그 조사는 별도 PR.
- Spec: `claude-deep-suite/docs/superpowers/plans/2026-05-12-m5.5-remaining-tests-handoff.md` §2 #5 (deep-review 행).

## [1.4.0] — 2026-05-08

M3 Phase 2 envelope adoption (handoff §3 절차). `.deep-review/recurring-findings.json` 을 M3 cross-plugin envelope 으로 emit (cf. `claude-deep-suite/docs/envelope-migration.md`). deep-work session-receipt 를 소비하는 reader 경로는 envelope-aware (strict 3-way identity guard). 패턴은 직전 plugin migration 인 deep-evolve PR #11 `9b867b1` 에서 채택. Phase 2 adoption ledger 는 suite repo 의 `docs/envelope-migration.md` §6.1 이 single source — 본 CHANGELOG 는 progress count 를 prose 에 두지 않는다 (handoff §4 cross-section count drift 규칙).

### 추가
- `hooks/scripts/envelope.js` — zero-dep CommonJS envelope 라이브러리. exports: `generateUlid` (MSB-first Crockford Base32 26-char ULID, 타임스탬프 간 lex-monotonic 보장), `detectGit` (head/branch/dirty trio + shallow CI clone fallback `0000000`/`unknown`), `loadProducerVersion` (caller cwd 가 아닌 module `__dirname` 기준으로 `.claude-plugin/plugin.json` 해결 — handoff §4 literal-cwd-resolve 교훈), `wrapEnvelope` (envelope 객체 빌드; null/array payload 거부 + own runId AND parentRunId 모두 ULID 검증을 라이브러리 경계에서 강제), `isEnvelope` (loose detector — `envelope` 키 없는 legacy receipt 와 충돌 없음), `isValidEnvelope` (strict — W4 payload-shape gate 추가로 corrupt envelope 가 downstream chain 에 trace data 기여하는 것 차단), `unwrapEnvelope` (legacy pass-through + identity-matched payload 추출 + corrupt payload stderr 경고 후 reject).
- `hooks/scripts/wrap-recurring-findings-envelope.js` — `commands/deep-review.md` Stage 5.5 ("Recurring Findings Export") 가 Bash tool 로 호출하는 CLI. GNU-style flag parsing 으로 `--key value` AND `--key=value` 모두 지원; required-value flag 의 빈 값을 CLI 단계에서 거부 (`--source-session-receipt=`, `--output=`, `--payload-file=`, `--session-id=`); 알 수 없는 flag 는 KNOWN_FLAGS allow-list 로 거부. `--source-session-receipt` 는 소비된 deep-work session-receipt 에 대해 strict 3-way identity check (producer=deep-work, artifact_kind=session-receipt, schema.name match) 수행 — 통과 시 그 `envelope.run_id` 가 자동으로 `parent_run_id` 로 chain (handoff §3.3) AND `provenance.source_artifacts` 에 run_id 와 함께 기록; legacy/foreign envelope 시 path 만 들어가고 chain 은 set 안 함 (corruption 차단). `--source-artifact <path[:run_id]>` 는 multi-source aggregation 용 repeatable (보통 review report markdown 경로); path-only 항목은 self-consistent envelope (producer === schema.name === artifact_kind, valid ULID) 인 경우 run_id 자동 수확, 아니면 path-only. caller 의 `--parent-run-id` (helper 진입 전 ULID 검증 — boundary validation) 는 자동 감지보다 우선. Atomic write: `<output>.tmp.<pid>.<Date.now()>` + `fs.renameSync` — mid-write Ctrl-C/OOM/hook-timeout 또는 두 writer 동시 실행이 truncated artifact 를 만들지 않음 (deep-work round-1 C1 교훈).
- `scripts/validate-envelope-emit.js` — suite repo 의 `artifact-envelope.schema.json` 을 외부 schema validator 의존 없이 zero-dep 로 mirror 하는 release lint. 강제 사항: `additionalProperties:false` (root, envelope, git, schema, provenance, source_artifacts items — root + envelope 은 `^x-` 접두 forward-compat 키 추가 허용); `producer === "deep-review"`; `artifact_kind === schema.name` (round-4 identity drift guard); ULID 26-char Crockford Base32 (I/L/O/U 제외) for run_id + parent_run_id; SemVer 2.0.0 strict for producer_version (leading zero 거부, prerelease + build metadata 허용); RFC 3339 for generated_at; `git.head` 정규식 `/^[a-f0-9]{7,40}$/`; `git.dirty ∈ {true, false, "unknown"}`; `tool_versions` container 가 object (배열 아님 — JS `typeof []==='object'` gotcha guard, handoff §4 round-3) AND 각 value 가 string OR (object && !array); payload 는 non-null/non-array object (도메인 shape 은 suite payload-registry 가 Phase 3 에서 lock). exit 0/1/2 = valid/invalid/IO-error. 파일별 `OK`/`FAIL` 라인 + 들여쓴 에러 사유 출력.
- `tests/envelope-emit.test.js` + `tests/envelope-chain.test.js` (87 cases via `node --test`) — generateUlid lex-monotonic, wrapEnvelope identity 거부 (artifactKind/payload/parentRunId), unwrapEnvelope identity guard (producer/artifact_kind/schema.name 3-way + corrupt payload), isEnvelope/isValidEnvelope detection, loadProducerVersion literal-cwd-resolve, fixture round-trip, 모든 additionalProperties 위반, ULID/SemVer/RFC 3339/git.head 경계, **그리고** chain 계약: `recurring-findings.envelope.parent_run_id === consumed session-receipt.envelope.run_id` (handoff §3.3 contract test), CLI 의 malformed `--parent-run-id` 거부 + required flag 빈 값 거부, session-receipt 경로의 foreign envelope 거부 (chain 안 함, run_id 가 source_artifacts 로 새지 않음), atomic write residue 검사.
- `tests/fixtures/sample-recurring-findings.json` — canonical envelope-wrapped emit. Phase 3 에서 suite repo 의 payload-registry placeholder 를 authoritative shape 로 교체 (`claude-deep-suite/schemas/payload-registry/deep-review/recurring-findings/v1.0.schema.json`) 하는 입력으로 사용.
- `package.json` `scripts.test` — `node --test tests/envelope-emit.test.js tests/envelope-chain.test.js`.

### 변경
- `.claude-plugin/plugin.json` 와 `package.json` `version`: `1.3.4` → `1.4.0` (envelope adoption 은 새 contract — handoff §3.4 의 minor bump 권장).
- `commands/deep-review.md` Stage 5.5 ("Recurring Findings Export") — payload 합성 (`.deep-review/reports/*.md` Critical+Warning 항목의 LLM taxonomy 분류) 결과를 `.deep-review/.tmp-recurring-payload.<pid>.<RANDOM>.json` 임시 파일에 기록한 뒤, `wrap-recurring-findings-envelope.js` 가 envelope-wrap 된 최종 artifact 를 `.deep-review/recurring-findings.json` 에 produce. Bash snippet 은 `set -euo pipefail` + gated cleanup (helper 성공시에만 `rm`; 실패시 payload 임시 파일을 보존하여 LLM 분류 단계 재실행 없이 retry 가능 — deep-work round-1 C2 교훈) 사용. `${CLAUDE_PLUGIN_ROOT:?...}` 와 `git rev-parse --show-toplevel` 로 caller contract 명시 + Bash tool 의 fresh-shell 가정 처리 (export 가 invocation 간 persist 안 됨 — deep-evolve round-2 R2-3 교훈). Multi-source: 모든 review report markdown 경로가 repeatable `--source-artifact` 로 `provenance.source_artifacts` 에 기록 (path-only — markdown 은 envelope detect 안 됨, run_id 없음).
- `commands/deep-review.md` Stage 3 ("Receipt health_report 주입") — receipt loader 를 envelope-aware 로 전환. Detection: 최상위 `schema_version === "1.0"` AND `envelope` (object) AND `payload` 존재. Strict 3-way identity guard (producer=deep-work, artifact_kind=session-receipt, schema.name=session-receipt) AND payload non-null/non-array — 모두 통과 시에만 `payload.health_report` 를 읽고 `envelope.run_id` 를 `SOURCE_SESSION_RECEIPT_RUN_ID` 로 보존 (Stage 5.5 chain 소스). Identity mismatch (foreign producer / drift / corrupt payload) 는 legacy fall-through 가 **아니라** "envelope identity mismatch — skip" 경고 발생 (corruption 노출 — round-1 C2 + corrupt-payload 교훈). Legacy (envelope-shape 부재) receipt 는 기존대로 최상위 `health_report` 접근 fall-through; envelope 부재 시 SOURCE_SESSION_RECEIPT_RUN_ID 가 unset 상태로 남아 Stage 5.5 가 chain 안 함 (pre-1.4.0 호환).

### Cross-plugin chain 계약
- `recurring-findings.envelope.parent_run_id` := `<consumed session-receipt envelope.run_id>` — Stage 3 가 모든 identity guard 통과한 envelope-wrapped deep-work session-receipt 를 발견했을 때만. Stage 5.5 가 session-receipt 경로를 wrap helper 에 전달하면 helper 가 동일 3-way check 후 strict 하게 run_id 수확. Foreign envelope 은 path-only 로만 들어가며 run_id 가 leak 되지 않음 (defense-in-depth — silent run_id leak 은 M4 telemetry trace reconstruction 을 corrupt; deep-evolve round-1 C2 교훈). `tests/envelope-chain.test.js` 가 실제 CLI helper 를 통해 이 계약을 end-to-end 로 exercise.
- 두 downstream consumer (deep-evolve `init.md` Stage 3.5 + deep-work `gather-signals.sh`) 는 각자의 M3 PR (deep-evolve PR #11 `9b867b1`, deep-work PR #25 `6f23e79`) 에서 이미 envelope-aware. 그 identity check 가 본 writer 와 mirror-symmetric (producer=deep-review, artifact_kind=recurring-findings, schema.name match) 이므로 본 writer 의 emit 만으로 추가 consumer 변경 없이 chain trace 가능.

### 호환성 / 마이그레이션
- Pre-1.4.0 consumer 가 legacy 최상위 `findings[]` shape 으로 read 하던 경우, producer 도 pre-1.4.0 인 한 그대로 동작. Envelope wrap 은 payload 자체에 대해 **breaking change 가 아님** — `payload.findings`, `payload.taxonomy_version`, `payload.updated_at` 가 같은 shape 보존. Envelope-aware unwrap 을 이미 채택한 consumer (M3 PR 시점의 deep-evolve, deep-work) 는 unwrap 결과가 동일 shape 이라 그대로 동작. Pre-envelope consumer 가 1.4.0 emit 에서 최상위 `findings[]` 를 read 하려 하면 그 키가 없으므로 envelope-aware read 또는 `payload.findings` 직접 접근으로 업그레이드 필요.
- 6-month 마이그레이션 윈도우 (handoff §6) 가 consumer plugin 의 envelope unwrap 채택 시간 제공. T+0 timer 시작점 기록 + `claude-deep-suite/docs/envelope-migration.md` §6.1 의 deep-review 행 갱신은 본 PR 에서 **의도적으로 하지 않음** — Phase 2 §1 정책이 모든 suite-repo 변경 (marketplace.json SHA bump, payload-registry 교체, adoption ledger 갱신, dashboard cutover) 을 6 번째 plugin merge 후 Phase 3 일괄 처리에 예약.

## [1.3.4] — 2026-04-24

1.3.3 릴리스 시 공개한 `Known limitations` 항목을 모두 해소하고 CI 커버리지를 추가한 후속 릴리스. Phase 1~5 로직 변경 없음. 서브에이전트 모델은 `sonnet` 유지. 병렬 dispatch는 non-goal 유지.

### 추가
- `skills/receiving-review/references/phase6-delegation-spec.md` — Phase 6 설계 스펙을 shipped on-demand reference로 이동. 기존 `docs/superpowers/specs/` 경로는 플러그인 repo의 `docs/` blanket ignore로 인해 사용자에게 전달되지 않았다.
- `hooks/scripts/test/test-phase6-protocol-e2e.sh` — 6개 시나리오 신설. **E6** `log_path` single-quote wrap이 공백·glob 포함 경로에서도 로그 파일을 정확한 경로에 생성함을 실증. **E7** `git diff --name-status -M` + awk 파이프라인이 staged rename의 new path만 추출 (staged ∪ unstaged 합집합 포함). **E8** `git hash-object`가 NUL byte 포함 binary 파일의 내용 변경을 감지. **E9** pre-existing dirty outside 경로 재수정이 content-hash snapshot 으로 감지됨 (allowlist bypass 차단). **E10** recovery 가 subagent `git add` 후 worktree + index 양쪽을 PRE 로 복원. **E11** recovery 가 tracked-but-deleted WIP (` D` 상태) 를 그대로 보존. 총 e2e 5 → 11.
- `.github/workflows/phase6-protocol.yml` — structural(10) + protocol e2e(11) 테스트를 `ubuntu-latest` **및** `macos-latest`에서 자동 실행하는 CI 워크플로(GNU vs BSD awk/sed 호환 검증 포함). `main` push와 agent / `commands/deep-review.md` / `skills/receiving-review/**` / 테스트 스크립트 / workflow 자체를 건드리는 PR에서 트리거. `permissions: contents: read` 최소 권한.

### 변경
- `agents/phase6-implementer.md` — literal `log_path` 치환 패턴에 **single-quote wrap 의무화**. `'\''` escape 규칙 명시. `printf '%q'` 는 single-quote wrap 맥락 안에서 **금지** (출력의 backslash 가 literal 로 남아 `/my\ repo/...` 같은 잘못된 경로 생성). 추가 금지 패턴: (a) single-quote 내부의 `tee -a "$log_path"` (빈 변수 확장), (b) quote 없는 `tee -a /path with space/log` (3개 인자로 word-split).
- `commands/deep-review.md` Step 2.5 (Phase 6 그룹 loop) — path-set baseline을 `git diff --name-status -M` (unstaged) **와** `git diff --cached --name-status -M` (staged) **의 합집합**으로 수집한 뒤 awk 후처리로 R/C rename/copy 라인의 new path만 채택. `git mv`는 자동 staged로 분류되므로 `--cached`를 함께 읽지 않으면 subagent가 Bash tool로 연 staged rename을 baseline이 놓쳐 trust-boundary gap이 된다 — 이를 막기 위한 구조. Binary 파일은 여전히 `git hash-object`를 통해 DELTA에 포함되며 이는 별도 분기 없음 — 명시적으로 문서화하여 숨겨진 로직을 추정하지 않도록.
- `commands/deep-review.md` Step 2.5 — 그룹 loop 상단에 "Step ↔ spec §5.4 매핑 테이블" 추가. 모든 step 헤더(3~8)에 `(spec §5.4.X)` 역참조. Spec §5.4 각 item에는 `(→ commands Step X)` 상호 참조 + 상단 매핑 테이블. 번호 자체는 재정렬하지 않음 (drift 위험) — 상호 참조만 추가.
- **톤 통일** — `commands/deep-review.md` 와 `skills/receiving-review/references/phase6-delegation-spec.md` 에 남아 있던 영문 warning 3건을 한국어로 교체 (`⚠ Phase 6 범위 외에 pre-staged 파일이 감지됐습니다:` 등). 리뷰/대응 UI 전반의 한국어 어조와 일관성 확보.
- **Placeholder 관습 명시화** — `agents/phase6-implementer.md`의 subagent 출력 template과 `phase6-prompt-contract.md`의 Accepted-Items prompt template 서두에 `<...>`는 "실제 값으로 치환해서 내보내야 할 placeholder", `{...}`는 "치환될 값의 타입 라벨"임을 각각 한 줄 선언. 그간 문자 그대로 반환될 위험이 있던 중의성 제거.

### 고침
- `phase6-delegation-spec.md` §5.4.2가 "§5.4.7 Dirty recovery"를 참조했으나 Dirty recovery는 §5.4.9. 정정. §5.4.9의 "Step 1에서 저장한"도 per-file snapshot이 §5.4.1에서 생성되므로 해당 spec 내부 참조로 교정.
- **Trust-boundary — pre-dirty outside path 경로 오염 차단** (3차 review C3): Step 5 검증이 ALLOWED 한정 DELTA 와 path-membership 만 보던 탓에, 이미 dirty 였던 non-ALLOWED 경로를 subagent 가 재수정해도 감지 못함. Step 3 에 `PRE_OUTSIDE_HASH_FILE` snapshot, Step 5 에 `OUTSIDE_VIOLATIONS` 계산 추가. E9 실증.
- **Trust-boundary — dirty recovery 가 index 를 복원 안 함** (3차 review W4): recovery 가 worktree 만 cp 복원 → subagent `git add`/`git mv` 효과 잔존. Step 7 에 pathspec-local `git restore --staged` / `git rm --cached --ignore-unmatch` 추가. E10 실증.
- **Recovery — tracked-but-deleted WIP 보존** (3차 review C5): `PRE_HASH==absent` 가 "원래 untracked" 와 "tracked 였으나 WIP-deleted" 를 뭉쳐 recovery 후 ` D` → `D ` (unstaged-delete → staged-delete) 로 변질. Step 3 에 `PRE_TRACKED_FILE` (via `git ls-files --error-unmatch`), Step 7 에서 pre_tracked 분기로 해결. E11 실증.
- **macOS `/bin/bash` 3.2 호환성** (3차 review C4): Step 3/5/7 이 `declare -A` (bash 4+) 사용 → macOS 기본 shell 에서 `invalid option` exit 2. associative array 를 TSV temp file 로 전면 교체 (`PRE_HASH_FILE`, `PRE_TRACKED_FILE`, `PRE_STAGED_FILE`, `PRE_OUTSIDE_HASH_FILE`). lookup 은 `awk -F'\t'` / `while IFS=$'\t' read`.
- **Partial-hunk staging 사용자 경고** (3차 review W7 — minimal fix): `git restore --staged` 가 사용자 `git add -p` hunk-selection state 까지 un-stage. Step 3 에 `PRE_STAGED_FILE` 기록, Step 7 에서 해당 경로 목록을 사전 warning + response.md 로그. 완전한 blob-level snapshot 은 v1.3.5 후보.
- **Spec ↔ agent test-order drift** (3차 review W8): `phase6-delegation-spec.md` 의 테스트 명령 우선순위가 hooks-first 였으나 agent `:46-52` 는 hooks-fallback-only. Spec 을 agent 순서와 동일하게 재작성 + agent 를 normative source 로 명시.
- **tmp artifact rotation 확장** (4차 review N2): `/deep-review --respond` 의 `.deep-review/tmp/` rotation 이 `.log` 만 prev/로 이동시키고 C4 TSV snapshot (`phase6-*-{pre-hash,pre-tracked,pre-staged,pre-outside-hash}.tsv`) + W4/C5 `phase6-{severity}-baseline/` 디렉토리는 누적 방치됐다. 이제 세 종류 모두 동일 1단계 회전으로 묶여 직전 두 세션 artifact 만 디스크에 유지된다.

### Known limitations (v1.3.4)
- Phase 6 dogfood T3 / T4 (release gate §7.5) 미완. 실제 feature 브랜치의 live 리뷰가 필요한 수동 작업으로, 이번 세션 범위를 벗어나 follow-up 세션 태스크로 기록. 프로토콜 회귀 없음 (structural 10 + e2e 11 green) — manual verification 리추얼만 미룸.
- `git add -p` partial-hunk staging 의 완전한 blob-level 복원은 미구현 (v1.3.5 후보). 현재는 영향받는 경로 warning + response.md 기록으로 bounded — 사용자가 `git add -p` 를 재실행해 복구.
- `--qa` 플래그는 여전히 reserved-only (v1.3.4 out-of-scope).

## [1.3.3] — 2026-04-24

### Added
- `agents/phase6-implementer.md` — Phase 6 구현 전용 서브에이전트(`model: sonnet`). `/deep-review --respond`에서 자동 dispatch.
- `hooks/scripts/test/test-phase6-subagent.sh` — Phase 6 위임 구조 회귀 방지 검증 스크립트 (10개 체크 — `Execution path` 대소문자 회귀 가드 포함).
- `hooks/scripts/test/test-phase6-protocol-e2e.sh` — 실행 가능한 end-to-end 테스트 (5개 시나리오). 임시 git repo에서 main 검증 로직을 실제 실행하여 suffix 정규화, `git hash-object` content-aware delta, `:(exclude)` pathspec 배열, companion files allowlist, per-file content baseline WIP 보존을 각각 실증.
- `implementation_guide.modifiable_paths` — Phase 5 accepted-item 계약에 신규 필드. Main이 Phase 6 allowlist에 companion 파일(test/fixture/helper)을 union으로 포함하여 acceptance 충족에 필요한 정상 multi-file 수정을 차단하지 않음.

### Changed
- `/deep-review --respond` Phase 6 실행이 심각도 그룹별로 `phase6-implementer` 서브에이전트에 위임된다 (기본 경로). Dispatch 실패 시 main 세션이 graceful fallback으로 직접 수행.
- `.deep-review/responses/*-response.md`의 Summary에 `execution_path` 필드(`subagent | main_fallback | mixed | n/a`)와 per-item `log_unavailable` 플래그 추가.
- Phase 6 테스트 로그를 `.deep-review/tmp/phase6-{severity}.log`에 저장 (ephemeral, 1단계 회전 — 직전 세션 로그는 `tmp/prev/`).
- 사용자 프로젝트용 `.gitignore` 권장 블록(`/deep-review init` Step 8)에 `.deep-review/tmp/` 라인 추가.
- **Fail-closed main 검증** (이전 non-blocking warning 대체):
  - `files_changed` claim을 suffix strip(`sed -E 's/ \(\+[0-9]+ -[0-9]+\)$//'`)으로 정규화 후 비교.
  - `DELTA`를 path-membership이 아닌 `git hash-object` content snapshot 기반으로 재정의 — dirty-tree 워크플로(staged/unstaged/mixed) 완전 지원.
  - `VIOLATIONS = NEW_PATHS - ALLOWED` 와 `REVERTED = PRE_ALL - POST_ALL` 둘 다 `execution_status=error`로 라우팅, commit·PR posting 억제.
  - 로그 파일 부재 → `log_unavailable=true`, error.
- **그룹 커밋**을 `git commit --only -m "..." -- "${CHANGED_FILES[@]}"` (flag가 `--` 앞에 있어 메시지가 pathspec으로 파싱되지 않음)로 수행. Untracked 신규 파일은 먼저 `git add`. Pre-staged hunk는 for 루프로 빌드한 `:(exclude)` pathspec 배열로 감지(bash 확장 버그 회피).
- **Dirty recovery**는 Step 3에서 `.deep-review/tmp/phase6-{severity}-baseline/`에 저장한 per-file content snapshot으로 복원. `git restore --source=HEAD`는 pre-existing 사용자 WIP를 파괴하므로 **명시적 금지**.
- `receiving-review/references/response-protocol.md`의 Phase 6 섹션은 이제 요약이며 `commands/deep-review.md`를 authoritative source로 선언 (drift-proof).

### Behavior notes
- 심각도 그룹 내 부분 실패 시 해당 그룹 기록 후 이후 그룹 스킵. 부분 실패 그룹은 **커밋되지 않으며**, passed 항목의 워킹 트리 수정은 사용자 검토를 위해 유지.
- Dispatch 실패로 main fallback 전환 시 남은 항목이 5건 이상이면 AskUserQuestion으로 "여기까지 / 계속" 선택 (context 여력 안전장치).
- 서브에이전트가 malformed/error로 반환하고 workspace가 dirty하면 main이 사용자에게 확인(keep / restore-from-baseline / abort) 후에만 진행.
- `DEEP_REVIEW_FORCE_FALLBACK=1` 환경변수로 강제 fallback 경로 진입 가능 (dogfood / 테스트용).

### Known limitations (v1.3.3)
- 공백/glob 문자가 포함된 `log_path`는 agent의 literal 치환에서 shell quoting이 필요할 수 있음 (v1.3.4 follow-up).
- Rename/binary 파일 처리는 default `git diff` 동작에 의존. `--name-status` 기반 precision은 v1.3.4 후보.
- 설계 스펙은 `docs/`에 있고 플러그인 repo가 이 디렉토리를 blanket ignore하므로 ship되지 않음. 런타임 authoritative 참조는 `commands/deep-review.md` + `skills/receiving-review/references/response-protocol.md`.

## [1.3.2] — 2026-04-21

### 추가

- **Codex 자동 노출 프로토콜 (Case 3)**: `/deep-review` 가 이번 Claude Code 세션에서 Edit/Write 한 gitignored 파일을 자동 감지 → 사용자 승인 하에 `git add -f -N` 으로 임시 index 노출 → 3-way 리뷰 후 `git rm --cached` 로 원복. 동시 세션 상호 배제는 `mkdir` 기반 atomic lock (`.deep-review/.mutation.lock/`, POSIX-portable, `flock` 의존성 없음). 상태는 `.deep-review/.pending-mutation.json` (schema_version: 1) 로 추적.
- **공유 Bash 라이브러리**: 신규 `hooks/scripts/mutation-protocol.sh` — 7개 함수 (`is_our_ita_entry`, `acquire_mutation_lock`, `release_mutation_lock`, `perform_mutation`, `restore_mutation`, `auto_recover`, `scan_sensitive_files`). bash 3.2 호환 (`mapfile`, `globstar` 미사용), macOS + GNU Linux 양쪽 테스트.
- **F1 / 플러그인 감지 경계**: `openai-codex` marketplace 만 신뢰되는지 테스트로 강제. 다른 marketplace 경로는 명시적으로 거부 (supply-chain 경계).
- **F2 / Node.js 가용성**: `detect-environment.sh` 가 모든 출력 분기(non-git / no-commits / main)에서 `node_available` + `node_path` 출력. preflight 가 "플러그인 설치됨 but node 없음" 을 일반 실패와 구분해 명확히 안내.
- **F3 / Codex 인증 오류 구분**: review / adversarial-review stderr 를 캡처하고 `not authenticated`, `Codex CLI is not authenticated`, `Run.*codex login` 패턴을 매칭. 매칭 시 "`!codex login` 후 재시도" 전용 안내.
- **세션 추론 (Stage 2.1)**: Edit / Write tool call 이력을 반추하여 작업 중인 gitignored 파일을 추정. 엄격 규칙 — **Read / Bash 는 제외** (false positive 방지).
- **민감 파일 스캔**: 40+ 패턴 (dotenv, credentials, SSH 키, GCP 서비스 계정, `.pgpass`, `.netrc`, `wrangler.toml`, JWT 등) 을 Python `fnmatch` 로 case-insensitive 매칭. `apps/web/.env.local` 같은 monorepo 중첩 경로 포함. 전원 민감 파일이면 프롬프트 없이 자동 skip.
- **Mutation 실패 시 graceful fallback**: `perform_mutation` 이 실패하면 (precondition 또는 `git add` 오류) 전체 `/deep-review` 를 중단하는 대신 1-way Opus 단독 리뷰로 자동 전환.
- **Stale mutation 자동 회수**: `/deep-review` 와 `--respond` 진입 시 크래시된 이전 세션의 `.pending-mutation.json` 을 `is_our_ita_entry` 필터로 silent 정리 (사용자가 이후 실제 staging 한 파일은 보존). `restore_attempts` 카운터가 3회 이상이면 사용자 에스컬레이션.

### 고침

- **F8 / Codex `--uncommitted` → `--scope working-tree` (pre-existing bug)**: Codex companion 1.0.x 는 `--base <ref>` 와 `--scope <auto|working-tree|branch>` 만 지원. `--uncommitted` 는 positional (focus text) 로 분류되어 native review 가 거부함. 이 silent 실패는 v1.3.x 내내 존재했으며 이번에 발견·교정. `commands/deep-review.md`, `SKILL.md`, `codex-integration.md` 전체에 반영.
- **`detect-environment.sh` empty-tree SHA**: fallback `review_base` 가 `4b825dc642cb6eb9a060e54bf899d69f7cb46617` 였는데 유효한 git empty-tree object 가 아님. 정식 해시 (`git hash-object -t tree /dev/null` 로 확인) 는 `4b825dc642cb6eb9a060e54bf8d69288fbee4904`. git 이 잘못된 값을 임의 treeish 로 silent 수용해 표면화되지 않았음.

### 변경

- **Case 게이트 확장**: Case 3 (3-way 리뷰) 는 `is_git=true AND codex_plugin=true` 만 필요. 기존 `has_commits=true` 요구 제거 — 첫 커밋 전 상태의 리포지터리도 `--scope working-tree` 로 교차 모델 리뷰 가능.
- **Case 명칭 변경**: A/B/C → 1/2/3 (commands, SKILL.md 전체).
- **`.gitignore` init 블록**: init 모드가 `.deep-review/.pending-mutation.json`, `.deep-review/.mutation.lock/` 제외 제안 포함.

### 폐기 예정

- **`detect-environment.sh` 의 `codex_installed` 필드**: v1.3.2 에서는 하위호환을 위해 계속 출력되나 **v1.4.0 에서 제거 예정**. 새 소비자는 `codex_plugin` 을 직접 사용. 현재 in-repo 소비처는 0건.

### 참고

- **bash 3.2 호환성**: `mutation-protocol.sh` 의 모든 신규 코드는 `mapfile`, `globstar` 및 bash 4+ 전용 기능을 피함. macOS `/bin/bash` 3.2.57 에서 테스트.
- **F1 marketplace 완화 유보**: v1.3.2 기획 초기에 `~/.claude/plugins/cache/*/codex/*` 로 플러그인 경로 완화를 고려했으나, 3회차 리뷰에서 supply-chain 리스크 (임의 marketplace 의 `codex` 이름 플러그인이 trusted executable 이 됨) 지적으로 유보. F1 은 backlog 이동 — publisher 검증 선행 후에만 재오픈.
- **4회차 리뷰 수정사항**: 구현 완료 dogfood 에서 발견된 4개 버그를 머지 전 수정:
  - **FR1**: `perform_mutation` 이 precondition 실패 시 early-return 전에 `release_mutation_lock` 호출 (최대 1시간 lock 누수 문제 해결).
  - **FR2**: `git add -f -N` 부분 실패 시 `restore_mutation` 을 inline 호출해 partial intent-to-add entry 즉시 정리 (사용자 index 오염 방지).
  - **FR3**: `auto_recover` 가 `status` + `REVIEW_TIMEOUT_SECONDS` 로 crashed 세션과 active 리뷰를 구분 (`status=committed` 는 10분, `status=in-progress` 는 1시간 기준).
  - **W1**: module-scoped `_MUTATION_LOCK_OWNED` 플래그로 다른 세션의 lock 을 실수로 해제하는 것을 방지.

### 알려진 제한

- **active 리뷰 중 빈 파일 staging (W2)**: `is_our_ita_entry` 는 사용자가 staging 한 진짜 빈 파일 (`.gitkeep` 등) 과 프로토콜의 intent-to-add placeholder 를 구분할 수 없음 (둘 다 `:000000 e69de29b...` 동일 raw record). Mutation 시점의 precondition 체크가 기존 staging 을 보호하지만, 리뷰 **진행 중** 사용자가 새로 staging 한 빈 파일은 restore 시 제거될 수 있음. 회피: Case 3 리뷰가 돌아가는 동안 새 빈 파일을 staging 하지 말 것. 완전 해결 (파일별 pre-mutation index state 기록) 은 v1.4.0 backlog.

## [1.3.1] — 2026-04-17

### 수정

ultrareview 감사(`.deep-review/reports/2026-04-17-ultrareview.md`)에서 발견된 모든 항목을 반영했다.

#### 🔴 Critical
- **공개 플러그인 레포용 `.gitignore`**: `.deep-review/`와 `docs/`를 완전히 ignore (이 레포는 플러그인 소스이며 dogfooding 로그/내부 문서는 공개 대상이 아님). 과거 tracked였던 설계 문서 하나도 untrack. 사용자 프로젝트용 `.gitignore`는 `/deep-review init`이 계속 세분화된 규칙을 제안한다.
- **WIP 커밋 안전화**: `git add -A` 제거. 제안 전에 파일 목록 미리보기 + 민감 패턴(`.env*`, credentials, key) 경고. 리뷰 후 `git reset --soft HEAD~1` 원복 힌트.
- **`mktemp` 기반 adversarial focus 파일**: 고정 `/tmp/deep-review-focus.txt` 제거. `chmod 600` + `trap rm -f` 정리. /tmp race / symlink 공격 표면 제거.
- **`config.yaml` 수정은 `Edit` tool 전용**: 사용자가 수동 설정한 필드(`review_model`, `app_qa.*`)와 미지 필드 보존. `last_review`를 리뷰 완료 시 ISO8601로 명시적 업데이트.

#### 🟡 Warning
- **POSIX 호환 semver 정렬**을 `detect-environment.sh`에 적용(기존 `sort -V` 대체). 현재 macOS(Darwin 25)에서 검증, BusyBox awk는 미검증. pre-release 식별자 순서는 지원하지 않음(한계 명시).
- **Prompt injection 방어** 문구를 `code-reviewer` system prompt과 PR 코멘트 수집 단계에 추가. 의심 문구는 보안 이슈로 보고.
- **리뷰 리포트 파일명에 `{HHmmss}` 타임스탬프 추가** — 같은 날 덮어쓰기로 인한 recurring-findings 카운트 오염 제거.
- **대용량 diff 전략**을 Stage 3에 추가: 크기 기준 라우팅, >1 MB는 디렉토리 그룹 순차 spawn, 300 KB+ 단일 파일 경고.
- **Codex preflight**를 실제 `timeout 10 node codex-companion --help`로 구체화. 실 호출에는 `timeout 300` 적용. 부분 실행 대비 N-way 합성 표 추가.
- **`gh pr view`/`gh repo view` 실패 처리** 명시. `--pr=NNN` 수동 지정 추가. `gh api` 부분 실패 시 전체 중단 금지.
- **Contract YAML**은 `python3 yaml.safe_load` 래퍼로 파싱. 오류 시 해당 contract만 skip.
- **`--respond`의 "가장 최근"**을 `*-review.md` glob의 mtime으로 정의 (비표준 `-ultrareview.md` 등 제외).
- **3단계 skill 로딩**: 네임스페이스 Skill → 일반 Skill → `${CLAUDE_PLUGIN_ROOT}/skills/...` Read fallback.
- **Recurring findings 분류** 단일 소스화(`response-protocol.md` Phase 1). SKILL.md, command는 참조만.
- **`Failed Postings` 섹션**을 response 리포트에 추가. PR 코멘트 게시 실패 추적 + 3회 연속 실패 시 에스컬레이션.
- **`untracked-only` + Codex 불일치** 해결: 기본 Opus 단독, 명시 요청 시 `git add -N` intent-to-add 경로.
- **머신별 vs 팀 공유** 정책을 README(EN/KO)에 문서화.

#### ℹ️ Info
- `/deep-review --qa`를 "향후 릴리스 예정"으로 명확화 (v1.1 약속 취소). `app_qa.*`는 예약 스키마로 유지.
- `package.json`에 `"category": "Productivity"` 추가 — `plugin.json`과 정렬.
- "Good catch!" 사용 규칙에 구체적 허용/금지 예시 추가.
- Source Trust Matrix 단일 소스를 `receiving-review/SKILL.md`로 명시. 다른 위치는 참조.
- WIP 원복 힌트(`git reset --soft HEAD~1`)를 양국 README에 노출.

### 추가 수정 (self-review 2차 라운드)

v1.3.1 패치 브랜치에 대해 `/deep-review`를 재실행하자 1차 라운드가 **새로 도입한 버그**가 드러남. 동일 릴리스에 함께 반영:

#### 🔴 Critical
- **`timeout` portable shim**: 1차 라운드의 `timeout 10` / `timeout 300` 래퍼가 macOS에서 `timeout(1)` 부재로 silently 실패. `codex-integration.md`에 `gtimeout`/`timeout`을 우선 시도하고 없으면 `perl -e 'alarm …'` (macOS 기본 탑재)로 fallback하는 `_timeout` 헬퍼 도입. preflight가 항상 FAIL 반환해 macOS에서 모든 교차 검증이 1-way로 전락하던 문제 해결.
- **`$focus_file` subshell scoping**: 1차 라운드의 `mktemp → Write → Bash` 3단계 흐름은 쉘 변수가 별개의 `Bash` 호출 간 유지된다는 잘못된 가정 기반. 단일 inline `Bash` 명령(here-doc + `_timeout 300 node …` + `rm -f`)으로 재작성. Option B(리터럴 경로 캡처)도 대안으로 문서화. `trap EXIT` 주의점 명시.

#### 🟡 Warning
- **`python3 yaml.safe_load` ImportError 가드**: stock macOS python3에 PyYAML 없음. Contract loader가 hard failure 대신 `{"ok": false, "error": "pyyaml-missing", "fallback": "llm-parse"}`를 반환하고, 호출 측은 이를 "LLM fallback" 신호로 취급하도록 명시.
- **`mktemp "${TMPDIR:-/tmp}/…"`**: macOS/GNU 간 semantics 차이로 취약한 `mktemp -t PREFIX` 대체.
- **WIP 민감 파일 경고**를 state-neutral 문구로 통일 (staged/unstaged/untracked 모두 동일 경고).
- **`failed-postings.json` 롤링 레저**: PR 코멘트 3-strike 재시도 룰의 세션 간 집계 경로 명시.
- **`--qa` Argument Dispatch 분기** 추가 — "향후 릴리스 예정" 메시지가 실제로 나오도록.
- **`argument-hint`가 상호 배타성** 표현 (`REPORT_PATH | --source=pr`).
- **영어 README `(v1.1 placeholder)` 제거** (한국어는 이미 수정됨).
- **양국 README의 파일명 placeholder** `{timestamp}` → `{YYYY-MM-DD}-{HHmmss}` 통일.
- **`.gitignore` 정책 주석**이 `docs/` blanket unignore를 경고하고 `.deep-review/journeys/` 또는 `docs/internal/`을 대안으로 제시.

#### ℹ️ Info
- **injection severity 통일**: PR 코멘트 injection 시도를 `DEFER`가 아니라 `security` / 🔴 `SECURITY_ESCALATION`으로 격상 (code-reviewer agent와 일치).
- **`detect-environment.sh` semver 한계** 주석: pre-release 식별자 미처리, 구버전 BSD awk `+0` 주의.
- **`forbidden-patterns.md` "Good catch"** 설명 재표현: technical clause vs. social filler, 문장부호는 마법이 아님.

## [1.3.0] — 2026-04-16

### 추가
- **Stage 5: Receiving Review** — 리뷰 피드백 증거 기반 대응 프로토콜. READ → UNDERSTAND → VERIFY → EVALUATE → RESPOND → IMPLEMENT 6단계 워크플로우로 맹목적 동의를 차단하고 모든 판단에 코드 증거를 첨부.
- **`/deep-review --respond`** — 대응 모드 진입. 가장 최근 리뷰 리포트를 자동 로드하거나 경로를 직접 지정.
- **`/deep-review --respond --source=pr`** — GitHub PR 리뷰 코멘트에 `gh api`를 통해 대응. 인라인 코멘트에는 스레드 답글.
- **`receiving-review` 스킬** — source 신뢰도 매트릭스, 금지 표현 차단, 합리화 탐지로 대응 프로토콜을 가이드.
- **Response Report** — 수락/반박/보류 결정을 evidence와 함께 구조화하여 `.deep-review/responses/`에 저장.
- **Recurring Findings 연동** — 대응 항목이 3회 이상 반복된 패턴과 일치하면 자동 경고.

### 변경
- **Stage 4 Verdict 행동** — `REQUEST_CHANGES` 시 3가지 선택지 제공: (1) 증거 기반 대응 (기본 추천), (2) codex:rescue 위임, (3) 수동 처리. 기존에는 codex:rescue만 제안.

## [1.2.0] — 2026-04-14

### 추가
- **Stage 5.5 반복 발견 패턴 내보내기**: taxonomy 기반(7 카테고리) LLM 의미 분류로 반복 발견 패턴을 `recurring-findings.json`에 기록. deep-evolve가 소비하여 실험 방향 조향에 활용.

## [1.1.2] - 2026-04-12

### 수정
- **Codex review 호출 버그** — `Skill(codex:review)` 호출 시 `disable-model-invocation: true`로 인해 `codex:rescue`가 실행되던 문제 수정; `codex-companion.mjs`를 Bash tool로 직접 호출
- **focus_text 쉘 인젝션** — repo 파일(rules.yaml, contract)에서 생성된 focus_text가 쉘 명령에 직접 삽입되던 문제; stdin 리다이렉트로 전달
- **플러그인 미설치 시 스크립트 중단** — `set -euo pipefail`에서 Codex 플러그인 경로 미존재 시 스크립트 종료; `|| true` fallback 추가
- **dirty tree 리뷰 불일치** — Codex가 커밋 히스토리(`--base`)만 리뷰하고 Opus는 dirty diff를 리뷰하던 문제; dirty tree에서 `--uncommitted` 사용

### 변경
- **Codex 감지 분리** — `codex_plugin`(Claude Code 플러그인)과 `codex_cli`(독립 CLI) 감지 분리, `codex_companion_path` / `codex_cli_path` 경로 출력
- **CLI만 설치 시 안내** — Codex CLI만 설치된 경우 맞춤 안내: "CLI가 감지되었지만 플러그인이 필요합니다"

## [1.1.1] - 2026-04-11

### 변경
- **Stage 3 백그라운드 실행** — 모든 리뷰어(Opus 서브에이전트, codex:review, codex:adversarial-review)를 `run_in_background: true`로 백그라운드에서 실행
- **리뷰 전 유저 고지** — 리뷰어 구성을 spawn 전 표시: Opus 단독(Case A/B) 또는 3-way(Case C)
- **Stage 4 결과 수집 방식** — 백그라운드 완료 알림으로 결과 수집; 부분 성공 시 실제 완료된 리뷰어 수 기준 N-way 합성

## [1.1.0] - 2026-04-09

### 추가
- **fitness.json 통합** — Stage 3는 이제 `.deep-review/fitness.json`(있는 경우)을 로드하고 컴퓨테이션 아키텍처 규칙을 code-reviewer 에이전트 프롬프트에 주입하여 아키텍처 의도 인식 리뷰 수행
- **Receipt health_report 통합** — Stage 3는 최신 deep-work 세션 receipt를 발견하고 `scan_commit`의 오래됨 여부를 확인하며 drift/fitness 컨텍스트를 리뷰에 주입
- **Code-reviewer의 Fitness Function 인식** — 새로운 "Fitness Function 인식" 섹션은 리뷰어가 규칙 위반만 아니라 설계 의도 정렬을 평가하도록 가이드
- **init 모드의 fitness.json 가이던스** — `/deep-review init`은 이제 추론 규칙(rules.yaml)과 컴퓨테이션 규칙(fitness.json)의 차이를 설명하고 사용자를 deep-work Phase 1으로 자동 생성을 위해 안내

## [1.0.0] - 2026-04-08

### 추가
- Mode 1: Code Review — 독립 Opus 서브에이전트 리뷰
- Codex 교차 검증 (codex:review + codex:adversarial-review)
- Sprint Contract 소비 및 검증
- 엔트로피 탐지
- 환경 자동 감지 (git/non-git, Codex 유무)
- `/deep-review init` — 프로젝트별 규칙 초기화

### 변경
- `--contract`는 이제 slice 특정 contract 로딩을 위해 `SLICE-NNN` 지원
- Contract 로딩: `status: active`인 모든 contracts을 자동 로드, 아카이브된 contracts는 제외
- 리뷰 기준을 command, SKILL.md, README에 걸쳐 정렬

### 수정
- change_state에 관계없이 항상 untracked 파일을 리뷰에 포함
- Codex 통합 합성 규칙과 command verdict 로직 정렬 (2/3 → CONCERN)
- 무음 성능 저하를 방지하기 위한 Codex preflight 체크 추가
- codex_notified를 repo 영구적으로 명확화 (session-scoped 아님)
- 에이전트 파일 참조에 전체 경로 추가
- 자동 생성된 config.yaml을 전체 schema와 정렬
- SKILL.md의 중복 단계 번호 수정, exclusions에 *.lock 추가
- Shallow clone 처리 및 사용자 가이던스 추가
- Archived contract 필터 및 malformed YAML 오류 처리 추가
