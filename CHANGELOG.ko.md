# 변경 기록

[English](./CHANGELOG.md) | **한국어**

deep-review의 모든 주요 변경 사항을 이 파일에 기록합니다. [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)와 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)을 따릅니다.

## [1.8.1] — 2026-05-25 (agy read-only 강제)

### 수정

- agy 리뷰어가 Stage 4 합성 단계가 아니라 Stage 3 리뷰 *도중에* Edit/Write 수정을 워크스페이스에 적용할 수 있던 문제. agy bridge가 파일/git/상태 변경을 금지하는 read-only 프리앰블(ASCII 전용, locale-safe)을 프롬프트 앞에 삽입하도록 변경. 변경이 발생하면 pre/post 워크트리 fingerprint에 걸려 agy 결과가 N-way 합성에서 제외된다.

### 변경

- read-only 프리앰블용 argv 여유 확보를 위해 agy 프롬프트 본문 한도를 200 KB → 198 KB로 하향.

## [1.8.0] — 2026-05-22 (symlink·디렉토리명 커버리지)

### 추가

- 사이드카 `sensitive-patterns-dir-match.list` 로 선택된 민감 패턴이 디렉토리명 매칭에 opt-in 가능 (`credentials*`, `bearer_*` 기본 활성).
- 민감 스캔·런타임 상태 스냅샷·full-walk 모드가 공유하는 symlink-aware 워크트리 fingerprint.

### 수정

- in-repo 파일(≤ 16 KB)을 가리키는 기존 런타임 상태 symlink(`config.yaml`, `.pending-mutation.json`)도 스냅샷되어 symlink를 통한 쓰기가 감지된다.
- full-walk·hybrid 민감 스캔이 일반 파일과 함께 symlink도 열거.
- symlink 해석이 40 링크에서 제한되어 무한 대기 대신 명확한 cycle 메시지로 실패.

## [1.7.2] — 2026-05-22 (hybrid 커버리지 보강)

### 수정

- hybrid 모드 민감 스캔이 bilateral-wildcard 패턴에 대해 토큰이 디렉토리명에만 있는 gitignored 시크릿(예: `./secrets/config.json`)도 감지.
- hybrid 모드가 `.deep-review/config.yaml`과 `.deep-review/.pending-mutation.json`을 해싱하여 agy가 자체 bridge 설정/락 상태를 변경하는 것을 감지.

## [1.7.1] — 2026-05-22 (agy fingerprint hybrid 모드)

### 변경

- 기본 agy fingerprint 모드가 `full-walk` → `hybrid`(`git status` + dirty 파일별 SHA-256 + 집중 민감 패턴 스캔)로 변경되어 대형 repo에서 약 100× 빨라짐. 이전 동작은 `config.yaml`의 `agy_fingerprint_mode: full-walk` 또는 `AGY_FINGERPRINT_MODE=full-walk`로 복원.

### 추가

- `lib/sensitive-patterns.list` — mutation 프로토콜과 agy bridge가 함께 읽는 공유 민감 패턴 데이터.
- `agy_fingerprint_mode` 설정 필드 및 `AGY_FINGERPRINT_MODE` 환경변수 override; 모드 `hybrid` | `full-walk` | `git-status` | `off`.
- `off` 모드는 mutation 감지를 명시적으로 해제 (agy가 워크트리를 변경하지 않음이 확실할 때만 사용).

## [1.7.0] — 2026-05-20 (agy 4-way 리뷰 통합)

### 추가

- **교차 모델 파이프라인의 4번째 리뷰어로 Google Antigravity CLI(`agy`) 추가** — Opus + Codex review + Codex adversarial과 cross-vendor-family 병렬.
- cross-vendor 반대 의견 신호를 보존하는 4-way verdict 합성과 spawn 전 fingerprint 기반 민감 파일 확인.
- `agy_notified`, `agy_enabled`, `agy_sensitive_acked_fingerprint` 설정 필드 (기존 사용자 자동 마이그레이션, `agy_enabled: false` opt-out 보존).

### 변경 없음

- Codex mutation 프로토콜(`git add -f -N` + 락)은 codex 전용 유지; agy는 직교적인 `--add-dir` walk 사용.

## [1.6.1] — 2026-05-18 (Codex 네이티브 플러그인 manifest 및 AGENTS 가이드)

### 추가

- `.codex-plugin/plugin.json` — Claude Code manifest와 동일한 skill/hook 표면을 가리키는 Codex 네이티브 manifest.
- `AGENTS.md` — runtime surface, 검증, suite marketplace 갱신 단계를 다루는 Codex 프로젝트 가이드.

### 변경

- README가 기존 Claude Code 표면과 함께 Codex 호환성을 명시.

## [1.6.0] — 2026-05-16 (`/deep-review-loop` 가 user-invocable 스킬로)

### 변경

- `/deep-review-loop` 가 슬래시 커맨드에서 `user-invocable: true` 스킬로 이전되어 Codex CLI / Copilot CLI / Gemini CLI / Agent SDK에서 `Skill({ skill: "deep-review:deep-review-loop" })` 로 호출 가능. Claude Code에서는 `/deep-review-loop` 슬래시 진입이 그대로 동작하며, loop 동작은 변경 없음.

## [1.5.1] — 2026-05-13 (스킬 문서 정리)

### 수정

- 스킬/스펙 문서와 실제 shipped 산출물 간 문서 drift 해소 (비표준 agent frontmatter 필드 제거, dangling 상호 참조 정리, Phase 6 그룹 dispatch 규칙 single-source화). 커맨드/훅/런타임 동작 변경 없음.

## [1.5.0] — 2026-05-13

### 추가

- **`/deep-review-loop`** — `/deep-review`(리뷰)와 `/deep-review --respond`(대응)을 연속 실행하며 수렴까지 반복. `--contract [SLICE-NNN]` / `--entropy`(매 라운드 전달)와 `--max=N` 안전장치(기본 5, Review 호출만 카운트)를 수용. 자연 수렴(`APPROVE`, 🔴/🟡 없음), `--max` 도달, findings 정체, 운영 오류 누적, 사용자 중단 중 하나로 종료.

### 변경

- Codex 호출당 timeout을 300s → 900s로 상향. 대형/rate-limit diff에서 유효한 3-way 리뷰가 1-way로 강등되던 false-positive timeout 제거.
- mutation 락 orphan window를 600s → 1200s로 상향하여 새 900s 호출당 timeout 위에 유지 (`REVIEW_TIMEOUT_SECONDS`로 override).

## [1.4.2] — 2026-05-12 (cross-platform `stat` 수정)

### 수정

- `mutation-protocol.sh` 가 락 mtime을 BSD `stat -f %m` 먼저 해석했는데, Linux에서는 이것이 silently 오작동(GNU `-f`는 "filesystem status" 의미)하여 락 복구가 깨졌다. stat 순서를 GNU `-c %Y` 먼저, BSD `-f %m` fallback으로 반전.

## [1.4.1] — 2026-05-12

### 추가

- 잔여 락 + crashed mutation이 무관한 사용자 staging과 공존할 때의 mutation 락 stale-recovery 통합 테스트 추가 (orphan 감지, 락 해제, 사용자 staging 보존). 테스트 전용; 런타임 변경 없음.

## [1.4.0] — 2026-05-08

### 추가

- `.deep-review/recurring-findings.json` 을 M3 cross-plugin envelope으로 emit하며, 소비한 deep-work session-receipt의 `run_id`를 `parent_run_id`로 chain하여 교차 플러그인 trace 제공.

### 변경

- Stage 3 receipt loader와 recurring-findings emitter를 envelope-aware로 전환 (strict producer/artifact_kind/schema identity guard); foreign·corrupt envelope은 경고와 함께 skip.

### 호환성

- wrap된 payload(`findings`, `taxonomy_version`, `updated_at`)는 같은 shape 유지. legacy 최상위 `findings[]` 를 읽던 pre-envelope consumer는 envelope-aware unwrap으로 업그레이드하거나 `payload.findings`를 직접 접근해야 함; 6개월 마이그레이션 윈도우 적용.

## [1.3.4] — 2026-04-24

### 추가

- Phase 6 위임 스펙을 on-demand 참조로 ship (이전에는 blanket-ignore된 `docs/`에 있어 전달되지 않았음).

### 변경

- Phase 6 그룹 커밋이 staged·unstaged rename을 모두 읽어 subagent의 `git mv`가 allowlist를 벗어나지 못하게 함; binary 파일은 `git hash-object`로 delta 감지.
- 런타임 경고 문구를 리뷰/대응 UI 전반과 일치하도록 한국어로 통일.

### 수정

- pre-dirty outside 파일을 통한 allowlist 우회 — Phase 6 검증이 dispatch 전 dirty 집합 전체의 content hash를 스냅샷하여 allowlist 밖 변경을 플래그.
- dirty recovery가 실패한 subagent의 `git add` / `git mv` 후 워크트리뿐 아니라 git index도 복원.
- recovery가 tracked-but-deleted WIP 구분을 보존 (` D` 가 `D ` 로 변질되지 않음).
- macOS bash 3.2 호환성 — Phase 6 스니펫의 `declare -A` 를 TSV 임시 파일로 교체.

## [1.3.3] — 2026-04-24

### 추가

- `phase6-implementer` 서브에이전트 — `/deep-review --respond`가 자동 dispatch하는 Phase 6 구현 전용 에이전트.
- `implementation_guide.modifiable_paths` — Phase 6 allowlist에 acceptance 충족에 필요한 companion 파일(test/fixture/helper)을 포함.

### 변경

- `/deep-review --respond` Phase 6가 심각도 그룹별로 `phase6-implementer` 서브에이전트에 위임되며, dispatch 실패 시 in-session graceful fallback.
- 대응 리포트 Summary에 `execution_path` 필드(`subagent | main_fallback | mixed | n/a`) 추가.
- Fail-closed main 검증: `files_changed`를 정규화하고 `git hash-object` content 스냅샷으로 비교; allowlist 밖·되돌려진 경로는 `execution_status=error`로 라우팅하고 commit/PR 게시를 억제.
- 그룹 커밋은 비그룹 경로용 `:(exclude)` pathspec과 함께 `git commit --only` 사용; dirty recovery는 파일별 content baseline으로 복원.

## [1.3.2] — 2026-04-21

### 추가

- **Codex 자동 노출 프로토콜** — `/deep-review`가 세션에서 편집 중인 gitignored 파일을 감지해 Codex에 임시 노출(`git add -f -N`)하여 교차 모델 리뷰를 수행. `mkdir` 기반 atomic 락과 `.pending-mutation.json` 상태 파일로 보호.
- 공유 `mutation-protocol.sh` Bash 라이브러리 (bash 3.2 호환, macOS + Linux 테스트).
- Codex 인증 오류 감지 + 전용 "`!codex login` 후 재시도" 안내, "플러그인 설치됨 but node 없음"을 일반 실패와 구분하는 Node.js 가용성 probe.
- 민감 파일 스캔(40+ 패턴: dotenv, credentials, SSH 키, GCP 서비스 계정, `.pgpass`, `.netrc`, `wrangler.toml`, JWT) case-insensitive 매칭; 전원 민감 파일이면 자동 skip.
- mutation 실패 시 1-way Opus 단독 리뷰로 graceful fallback, crashed 세션의 stale mutation 자동 회수(사용자 실제 staging 보존).

### 수정

- Codex companion은 `--scope <auto|working-tree|branch>` 만 수용하는데 기존 `--uncommitted` 플래그는 silently 거부되고 있었다. 모든 호출 지점을 `--scope working-tree`로 교정.
- `review_base`로 쓰이던 empty-tree fallback SHA를 정식 git empty-tree 해시로 교정.

### 변경

- 3-way 리뷰가 git repo + Codex 플러그인만 요구하도록 변경(기존 "커밋 존재" 요구 제거 — 첫 커밋 전 repo도 교차 모델 리뷰 가능).

### 폐기 예정

- `detect-environment.sh` 출력의 `codex_installed` 필드 (`codex_plugin` 사용); 추후 릴리스에서 제거 예정.

## [1.3.1] — 2026-04-17

### 수정

- 공개 repo `.gitignore`가 `.deep-review/`와 `docs/`를 완전히 ignore; downstream 사용자는 여전히 `/deep-review init`에서 세분화된 안내를 받는다.
- WIP 커밋 안전화 — `git add -A` 제거; 제안 전 파일 목록 미리보기, 민감 패턴 경고, `git reset --soft HEAD~1` 원복 힌트.
- adversarial focus 파일을 `mktemp` + `chmod 600` + 정리로 처리해 `/tmp` race·symlink 공격 표면 제거.
- `config.yaml`을 `Edit` tool로만 갱신하여 사용자 수정 필드·미지 필드 보존.
- 리포트 파일명에 `{HHmmss}` 타임스탬프 추가로 recurring-findings 카운트를 오염시키던 같은 날 덮어쓰기 제거.
- 리뷰어 system prompt과 PR 코멘트 수집에 prompt-injection 방어 추가; 의심 문구는 보안 이슈로 플래그.

### 변경

- portable `_timeout` shim(`gtimeout`/`timeout` 우선, `perl alarm` fallback)으로 macOS에서 교차 모델 리뷰가 1-way로 silently 강등되지 않도록 함.
- Contract YAML을 PyYAML 부재 시 LLM 파싱으로 degrade하는 `yaml.safe_load` 래퍼로 로드; malformed contract는 경고와 함께 skip.
- Stage 3 대용량 diff 처리: 크기 기준 라우팅, 디렉토리 그룹 순차 spawn, 크기 상한 경고.
- `--respond`의 "가장 최근"을 `*-review.md` glob의 mtime으로 정의; `--pr=NNN` override와 실패한 PR 코멘트 게시의 idempotent 재시도 추적 추가.

## [1.3.0] — 2026-04-16

### 추가

- **Stage 5: Receiving Review** — 증거 기반 대응 프로토콜(READ → UNDERSTAND → VERIFY → EVALUATE → RESPOND → IMPLEMENT)로 맹목적 동의를 차단하고 모든 판단을 코드 증거로 뒷받침.
- **`/deep-review --respond`** — 가장 최근 리뷰 리포트 또는 지정 경로로 대응 모드 진입.
- **`/deep-review --respond --source=pr`** — `gh api`로 GitHub PR 리뷰 코멘트에 대응, 인라인 코멘트에 스레드 답글.
- `receiving-review` 스킬 — source 신뢰도 매트릭스, 금지 표현 차단, 합리화 탐지로 프로토콜을 가이드.
- Response Report — 수락/반박/보류 결정을 evidence와 함께 구조화하여 `.deep-review/responses/`에 저장.

### 변경

- `REQUEST_CHANGES` verdict가 3가지 선택지 제공: 증거 기반 대응(기본), `codex:rescue` 위임, 수동 처리.

## [1.2.0] — 2026-04-14

### 추가

- **Stage 5.5 반복 발견 패턴 내보내기** — taxonomy 기반(7 카테고리) LLM 분류로 반복 패턴을 `recurring-findings.json`에 기록, deep-evolve가 소비하여 실험 방향 조향.

## [1.1.2] — 2026-04-12

### 수정

- Codex review 호출이 `codex:rescue`로 잘못 라우팅되던 문제; Codex companion을 Bash tool로 직접 호출.
- 쉘 인젝션 — repo 제어 파일의 `focus_text`를 쉘 명령에 삽입하지 않고 stdin으로 전달.
- Codex 플러그인 경로 부재 시 `detect-environment.sh`가 중단되지 않도록 수정.
- dirty tree 리뷰 불일치 — Codex와 Opus가 동일한 변경을 리뷰.

### 변경

- Codex 감지를 `codex_plugin`(Claude Code 플러그인)과 `codex_cli`(독립 CLI)로 분리, "CLI가 감지되었지만 플러그인이 필요합니다" 맞춤 안내.

## [1.1.1] — 2026-04-11

### 변경

- 모든 리뷰어(Opus 서브에이전트, Codex review, Codex adversarial)를 백그라운드 실행하고, spawn 전 리뷰어 구성을 표시하며, 실제 완료된 리뷰어 기준 N-way 합성으로 결과 수집.

## [1.1.0] — 2026-04-09

### 추가

- `fitness.json` 통합 — Stage 3가 컴퓨테이션 아키텍처 규칙을 리뷰어 프롬프트에 주입하여 아키텍처 의도 인식 리뷰 수행.
- Receipt `health_report` 통합 — Stage 3가 최신 deep-work 세션 receipt를 발견하고 `scan_commit` stale 여부를 확인해 drift/fitness 컨텍스트를 주입.
- `/deep-review init`이 추론 규칙(`rules.yaml`)과 컴퓨테이션 규칙(`fitness.json`)의 차이를 설명하고 deep-work Phase 1 자동 생성으로 안내.

## [1.0.0] — 2026-04-08

### 추가

- 독립 Opus 서브에이전트 코드 리뷰.
- Codex 교차 검증(`codex:review` + `codex:adversarial-review`).
- Sprint Contract 소비 및 검증.
- 엔트로피 탐지.
- 환경 자동 감지(git / non-git, Codex 유무).
- `/deep-review init` — 프로젝트별 규칙 초기화.

### 변경

- `--contract`가 slice 특정 contract 로딩을 위해 `SLICE-NNN` 지원; `status: active` contract 자동 로드, 아카이브된 contract 제외.
- 리뷰 기준을 command, skill, README에 걸쳐 정렬.

### 수정

- change state에 관계없이 항상 untracked 파일을 리뷰에 포함.
- Codex 합성 규칙을 verdict 로직과 정렬(2/3 → `CONCERN`).
- 무음 성능 저하를 방지하기 위한 Codex preflight 체크 추가.
- shallow clone 처리, 아카이브된 contract 필터, malformed YAML 오류 처리 추가.
