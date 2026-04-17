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
2. 첫 번째 Codex 호출 시 실패하면 즉시 fallback — silent degradation 금지
3. 리포트에 각 리뷰어의 실행 상태를 명시 (성공/실패/미수행)

## 3-way 병렬 리뷰

Codex가 사용 가능할 때 3개 리뷰를 **백그라운드에서 동시 실행**:

1. **Claude Opus 서브에이전트** (Agent tool, model: opus, run_in_background: true)
   - 독립 컨텍스트에서 5가지 관점 리뷰
   - 항상 실행됨

2. **codex review** (Bash tool, run_in_background: true)
   - `node "{codex_companion_path}" review {codex_target_flag}`
   - `{codex_target_flag}`: clean/WIP 커밋 후 → `--base {review_base}`, dirty tree → `--uncommitted`
   - Skill tool이 아닌 Bash 직접 호출 (disable-model-invocation: true)

3. **codex adversarial-review** (Bash tool, run_in_background: true)
   - 호출 전 유니크 임시 파일 생성 (race/symlink 방지):
     `focus_file=$(mktemp -t deep-review-focus.XXXXXX) && chmod 600 "$focus_file"`
   - `node "{codex_companion_path}" adversarial-review {codex_target_flag} - < "$focus_file"`
   - `{codex_target_flag}`: 위와 동일
   - focus_text는 Write tool로 `$focus_file`에 저장 후 stdin으로 전달 (쉘 인젝션 방지)
   - 완료 후 `rm -f "$focus_file"` — 예외 경로 누수 방지 위해 `trap 'rm -f "$focus_file"' EXIT` 권장
   - focus_text: rules.yaml 규칙 + contract criteria에서 자동 생성
   - Skill tool이 아닌 Bash 직접 호출 (disable-model-invocation: true)
   - **금지**: 고정 경로 `/tmp/deep-review-focus.txt` 같은 predictable name 사용 금지 (공격 가능)

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
