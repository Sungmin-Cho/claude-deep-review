---
name: deep-review-workflow
description: |
  deep-review 플러그인의 코어 워크플로우 정의. 환경 감지, 리뷰 파이프라인,
  교차 검증, 리포트 합성 등 전체 리뷰 프로세스를 가이드한다.
user-invocable: false
---

# Deep Review Workflow

이 스킬은 `/deep-review` 커맨드에서 로드되어 리뷰 프로세스를 가이드합니다.

## 참조 문서

- `references/review-criteria.md` — 5가지 리뷰 관점
- `references/codex-integration.md` — Codex 교차 검증
- `references/contract-schema.md` — Sprint Contract 스키마
- `references/report-format.md` — 리포트 형식
- `../receiving-review/SKILL.md` — 리뷰 피드백 대응 프로토콜 (Stage 5)

## 4단계 파이프라인

### Stage 1: Collect (변경 수집)

1. 환경 감지 스크립트 실행: `bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/detect-environment.sh`
2. 결과를 key=value 형식으로 파싱
3. 결과에 따라 diff 수집:
   - `change_state=non-git` → 사용자에게 리뷰할 파일 목록 요청
   - `change_state=initial` → 모든 파일 대상 리뷰
   - `change_state=clean` → `git diff {review_base}..HEAD`
   - `change_state=staged` → `git diff --cached`
   - `change_state=unstaged` → `git diff`
   - `change_state=mixed` → `git diff HEAD` (staged + unstaged 모두)
   - `change_state=untracked-only` → `git ls-files --others --exclude-standard`로 파일 목록 수집
4. **모든 git 상태에서 untracked > 0이면:**
   - `git ls-files --others --exclude-standard`로 추가 파일을 리뷰 대상에 포함 (primary state의 diff와 union)
5. diff에서 제외: 바이너리, vendor/, node_modules/, *.min.js, *.generated.*, *.lock

### Stage 2: Contract Check (계약 검증)

`--contract` 플래그 처리:
- `--contract SLICE-{NNN}` (슬라이스 지정): `.deep-review/contracts/SLICE-{NNN}.yaml`만 로드 (status: active 확인)
- `--contract` (슬라이스 미지정): `.deep-review/contracts/` 내 모든 `status: active` contract 로드
- 플래그 없이 `.deep-review/contracts/`에 active contract가 있으면: 자동으로 전체 contract 검증
- contract 디렉토리가 없거나 active 파일이 없으면: 이 단계 건너뜀
- `status: archived` contract는 자동 로드에서 제외. 명시적 SLICE-NNN 지정 시에도 archived이면 경고 표시.
- YAML 파싱 오류 시: 해당 contract 건너뜀 + 경고 "Contract {파일명} 파싱 실패 — 건너뜀"

### Stage 3: Deep Review (교차 검증)

환경에 따라 리뷰어 구성이 달라짐:

**공통: 유저 고지 + 백그라운드 실행**
모든 Case에서 리뷰어 spawn 직전 고지 메시지를 출력하고, 모든 리뷰어를 백그라운드에서 실행한다.
- Case A/B: "Opus 리뷰를 백그라운드에서 실행합니다. 완료되면 결과를 알려드리겠습니다."
- Case C: "3개 리뷰어(Opus, Codex review, Codex adversarial)를 백그라운드에서 실행합니다. 완료되면 결과를 합성하여 알려드리겠습니다."
코드 경로 단일화를 위해 단독 리뷰어(Case A/B)에서도 백그라운드로 실행한다.

**대용량 diff 처리 (Agent prompt 크기 관리)**
리뷰어 spawn 전 diff 크기를 측정하고 임계치를 넘으면 전략을 조정한다:
1. 측정: `Bash({ command: "git diff {base}..HEAD | wc -c" })`로 바이트 수 확인
2. 임계치:
   - `< 200 KB` → 전체 diff를 agent prompt에 포함 (기본 경로)
   - `200 KB ~ 1 MB` → 파일 목록을 경로·변경라인 요약만 포함하고, agent가 필요한 파일을 `Read`로 직접 읽도록 지시 (이미 Read tool 보유)
   - `> 1 MB` → 자동 분할 방식으로 전환:
     a. `rules.yaml`의 `architecture.layers` 또는 디렉토리 트리에서 1차 그룹핑
     b. 그룹별로 code-reviewer agent를 순차 spawn (병렬 시 총합 프롬프트 압박)
     c. 최종 합성은 그룹별 리포트를 모아 상위에서 merge
3. `*.min.js`, `*.lock`, `*.generated.*`, `vendor/`, `node_modules/` 외에도 300 KB를 초과하는 단일 파일은 기본 exclusion 후보로 표시하고 사용자에게 포함 여부 확인.
4. Agent 호출이 size·token 오류로 실패하면 Stage 4의 "부분 성공" 경로로 처리하고 원인을 리포트에 기록. 무한 재시도 금지 (1회 재시도만 허용).

**Case A: non-git 또는 커밋 0건**
→ Claude Opus 서브에이전트 단독 리뷰 (run_in_background: true)

**Case B: git + 커밋 있음 + Codex 플러그인 미설치 (codex_plugin=false)**
→ Claude Opus 서브에이전트 단독 리뷰 (run_in_background: true)
→ 세션 내 최초 1회 안내:
  - codex_cli=false: Codex 플러그인 설치 안내
  - codex_cli=true: "CLI가 감지되었지만 플러그인이 필요합니다" 안내

**Case C: git + 커밋 있음 + Codex 플러그인 설치 (codex_plugin=true)**
→ 3-way 병렬 백그라운드 실행:
  1. Agent(code-reviewer, model: opus, run_in_background: true) — 독립 리뷰
  2. Bash(_timeout 300 node "{codex_companion_path}" review {codex_target_flag}, run_in_background: true) — 코드 리뷰 (`_timeout`은 `references/codex-integration.md` preflight 섹션의 portable shim)
  3. Bash (run_in_background: true) — adversarial-review를 **단일 Bash 호출 내에 inline**으로 실행한다. mktemp 생성 → here-doc으로 focus_text 주입 → `_timeout 300 node ... adversarial-review ... - < "$focus_file"` 호출 → 종료 후 `rm -f` 정리. 별도 Bash에 `$focus_file`을 넘기면 subshell 경계에서 unset되므로 **반드시 같은 Bash command 문자열 안에서 완결**. 상세 예제는 `commands/deep-review.md` Stage 3 참조. mktemp 경로는 `"${TMPDIR:-/tmp}/deep-review-focus.XXXXXX"` 형식 — 고정 경로 사용 금지.

{codex_target_flag}: clean 또는 WIP 커밋 후 → `--base {review_base}`, dirty tree → `--uncommitted`.
**untracked-only**는 git diff가 비어 Codex가 대상을 못 본다 — 기본적으로 Codex skip (Opus 단독), 명시 요청 시 `git add -N` intent-to-add 후 `--uncommitted`, 리뷰 완료 후 `git reset HEAD <files>`로 원복 (자세한 절차는 commands/deep-review.md 참조).

**커밋되지 않은 상태에서:**
- 사용자에게 WIP 커밋 제안
- 수락 → WIP 커밋 후 Case C (--base)
- 거부 → Claude Opus 리뷰 (diff 기반) + Codex도 실행 (--uncommitted로 동일 대상 리뷰)

### Stage 4: Verdict (판정)

1. 모든 백그라운드 리뷰어의 완료 알림 수신 후 결과 수집
   - 완료 알림은 Claude Code 런타임이 자동 전달 (polling 불필요)
   - 리뷰어 실패 시 "미수행" 표시, 성공한 리뷰어만으로 합성
2. 교차 검증 합성 (`codex-integration.md` 참조)
3. Verdict 결정: APPROVE / REQUEST_CHANGES / CONCERN
4. 리포트 생성: `.deep-review/reports/{YYYY-MM-DD}-{HHmmss}-review.md` (Bash `date "+%Y-%m-%d-%H%M%S"`로 타임스탬프 생성)
5. REQUEST_CHANGES 시:
   "대응 방법을 선택하세요:"
   (1) 증거 기반 대응 시작 (`/deep-review --respond`) ← 기본 추천
   (2) codex:rescue로 수정 위임 (Codex 설치 시에만 표시)
   (3) 수동으로 처리

## config.yaml 스키마

```yaml
# .deep-review/config.yaml
review_model: opus              # opus | sonnet (리뷰어 모델)
codex_notified: false           # Codex 설치 안내 1회 표시 여부
last_review: null               # 마지막 리뷰 시각 (ISO8601)
app_qa:                         # Mode 2 (향후 릴리스에서 구현 예정 — dead field 허용)
  last_command: null
  last_url: null
```

### 업데이트 원칙 (필드 보존)

- **필드 변경은 Edit tool로 해당 라인만 교체**. `Write`로 전체 파일을 덮어쓰지 않는다 — 사용자가 수동으로 수정했을 수 있는 다른 필드가 사라진다.
- 스키마에 없는 추가 필드가 있어도 삭제하지 않는다 (사용자의 확장을 존중).
- YAML 파서 없이 텍스트 매칭으로 수정하므로 `old_string`에 전/후 컨텍스트를 충분히 포함해 유일성을 보장.
