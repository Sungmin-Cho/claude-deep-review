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
3. **모든 git 상태에서 untracked > 0이면:**
   - `git ls-files --others --exclude-standard`로 추가 파일을 리뷰 대상에 포함 (primary state의 diff와 union)
4. diff에서 제외: 바이너리, vendor/, node_modules/, *.min.js, *.generated.*

### Stage 2: Contract Check (계약 검증)

1. `.deep-review/contracts/` 디렉토리 확인
2. contract 파일이 있으면 로드
3. `--contract` 플래그가 있거나, deep-work 연동 시 자동 실행
4. 없으면 이 단계 건너뜀

### Stage 3: Deep Review (교차 검증)

환경에 따라 리뷰어 구성이 달라짐:

**Case A: non-git 또는 커밋 0건**
→ Claude Opus 서브에이전트 단독 리뷰

**Case B: git + 커밋 있음 + Codex 미설치**
→ Claude Opus 서브에이전트 단독 리뷰
→ 세션 내 최초 1회 Codex 설치 안내

**Case C: git + 커밋 있음 + Codex 설치+인증**
→ 3-way 병렬 실행:
  1. Agent(code-reviewer, model: opus) — 독립 리뷰
  2. Skill(codex:review --background --base {base}) — 코드 리뷰
  3. Skill(codex:adversarial-review --background --base {base} "{focus}") — 적대적 리뷰

**커밋되지 않은 상태에서:**
- 사용자에게 WIP 커밋 제안
- 수락 → WIP 커밋 후 Case C
- 거부 → Claude Opus 리뷰 (diff 기반) + 가능하면 Codex도 실행

### Stage 4: Verdict (판정)

1. 모든 리뷰 결과 수집
2. 교차 검증 합성 (`codex-integration.md` 참조)
3. Verdict 결정: APPROVE / REQUEST_CHANGES / CONCERN
4. 리포트 생성: `.deep-review/reports/{날짜}-review.md`
5. REQUEST_CHANGES 시 + Codex 있으면: "codex:rescue로 수정을 위임하시겠습니까?" 제안

## config.yaml 스키마

```yaml
# .deep-review/config.yaml
review_model: opus              # opus | sonnet (리뷰어 모델)
codex_notified: false           # Codex 설치 안내 1회 표시 여부
last_review: null               # 마지막 리뷰 시각
app_qa:                         # Mode 2 (v1.1에서 구현)
  last_command: null
  last_url: null
```
