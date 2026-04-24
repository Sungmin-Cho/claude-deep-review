# 변경 기록

[English](./CHANGELOG.md) | **한국어**

## [1.3.4] — 2026-04-24

1.3.3 릴리스 시 공개한 `Known limitations` 항목을 모두 해소하고 CI 커버리지를 추가한 후속 릴리스. Phase 1~5 로직 변경 없음. 서브에이전트 모델은 `sonnet` 유지. 병렬 dispatch는 non-goal 유지.

### 추가
- `skills/receiving-review/references/phase6-delegation-spec.md` — Phase 6 설계 스펙을 shipped on-demand reference로 이동. 기존 `docs/superpowers/specs/` 경로는 플러그인 repo의 `docs/` blanket ignore로 인해 사용자에게 전달되지 않았다.
- `hooks/scripts/test/test-phase6-protocol-e2e.sh` — 3개 시나리오 신설. **E6** `log_path` single-quote wrap이 공백·glob 포함 경로에서도 로그 파일을 정확한 경로에 생성함을 실증. **E7** `git diff --name-status -M` + awk 파이프라인이 staged rename의 new path만 추출. **E8** `git hash-object`가 NUL byte 포함 binary 파일의 내용 변경을 감지. 총 e2e 5 → 8.
- `.github/workflows/phase6-protocol.yml` — structural(10) + protocol e2e(8) 테스트를 `ubuntu-latest` **및** `macos-latest`에서 자동 실행하는 CI 워크플로(GNU vs BSD awk/sed 호환 검증 포함). `main` push와 agent / `commands/deep-review.md` / `skills/receiving-review/**` / 테스트 스크립트 / workflow 자체를 건드리는 PR에서 트리거. `permissions: contents: read` 최소 권한.

### 변경
- `agents/phase6-implementer.md` — literal `log_path` 치환 패턴에 **single-quote wrap 의무화**. `'\''` escape 규칙 명시. `printf '%q'` 는 single-quote wrap 맥락 안에서 **금지** (출력의 backslash 가 literal 로 남아 `/my\ repo/...` 같은 잘못된 경로 생성). 추가 금지 패턴: (a) single-quote 내부의 `tee -a "$log_path"` (빈 변수 확장), (b) quote 없는 `tee -a /path with space/log` (3개 인자로 word-split).
- `commands/deep-review.md` Step 2.5 (Phase 6 그룹 loop) — path-set baseline을 `git diff --name-status -M` (unstaged) **와** `git diff --cached --name-status -M` (staged) **의 합집합**으로 수집한 뒤 awk 후처리로 R/C rename/copy 라인의 new path만 채택. `git mv`는 자동 staged로 분류되므로 `--cached`를 함께 읽지 않으면 subagent가 Bash tool로 연 staged rename을 baseline이 놓쳐 trust-boundary gap이 된다 — 이를 막기 위한 구조. Binary 파일은 여전히 `git hash-object`를 통해 DELTA에 포함되며 이는 별도 분기 없음 — 명시적으로 문서화하여 숨겨진 로직을 추정하지 않도록.
- `commands/deep-review.md` Step 2.5 — 그룹 loop 상단에 "Step ↔ spec §5.4 매핑 테이블" 추가. 모든 step 헤더(3~8)에 `(spec §5.4.X)` 역참조. Spec §5.4 각 item에는 `(→ commands Step X)` 상호 참조 + 상단 매핑 테이블. 번호 자체는 재정렬하지 않음 (drift 위험) — 상호 참조만 추가.
- **톤 통일** — `commands/deep-review.md` 와 `skills/receiving-review/references/phase6-delegation-spec.md` 에 남아 있던 영문 warning 3건을 한국어로 교체 (`⚠ Phase 6 범위 외에 pre-staged 파일이 감지됐습니다:` 등). 리뷰/대응 UI 전반의 한국어 어조와 일관성 확보.
- **Placeholder 관습 명시화** — `agents/phase6-implementer.md`의 subagent 출력 template과 `phase6-prompt-contract.md`의 Accepted-Items prompt template 서두에 `<...>`는 "실제 값으로 치환해서 내보내야 할 placeholder", `{...}`는 "치환될 값의 타입 라벨"임을 각각 한 줄 선언. 그간 문자 그대로 반환될 위험이 있던 중의성 제거.

### 고침
- `phase6-delegation-spec.md` §5.4.2가 "§5.4.7 Dirty recovery"를 참조했으나 Dirty recovery는 §5.4.9. 정정. §5.4.9의 "Step 1에서 저장한"도 per-file snapshot이 §5.4.1에서 생성되므로 해당 spec 내부 참조로 교정.

### Known limitations (v1.3.4)
- Phase 6 dogfood T3 / T4 (release gate §7.5) 미완. 실제 feature 브랜치의 live 리뷰가 필요한 수동 작업으로, 이번 세션 범위를 벗어나 follow-up 세션 태스크로 기록. 프로토콜 회귀 없음 (structural 10 + e2e 8 green) — manual verification 리추얼만 미룸.
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
