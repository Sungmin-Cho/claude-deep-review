# agy Integration Guide

## 감지 방법

`detect-environment.sh` 가 `_emit_agy_vars` 헬퍼로 다음 변수 출력 (모든 `exit 0` 경로에서):
- `agy_cli`: `command -v agy` 결과 (`true` / `false`)
- `agy_cli_path`: agy 바이너리 절대 경로
- `agy_version`: `agy --version` 의 첫 줄

`agy_cli=true AND agy_enabled=true` (config) 일 때 4번째 reviewer 활성화.

## Trust-boundary 차이 (vs codex / Opus)

agy 는 `--add-dir <project_root>` 로 디렉토리 트리 walk → codex (git index) / Opus (Read tool, explicit per-file) 와 다른 access model. `mutation-protocol.sh` 의 sensitive-file scan 은 mutation step 만 gating 하므로 agy 의 filesystem reach 는 별도 mitigation 필요. → 자세한 표는 spec §4.5 참조.

**Mitigation**: pre-spawn `scan_sensitive_files` + fingerprint-based acknowledgment (§4.5.1). config 필드 `agy_sensitive_acked_fingerprint` 에 SHA-256 fingerprint 저장. scan-on-every-spawn — 영구 boolean ack 폐기 (R5/R6 fix).

## Preflight

agy 호출 전 반드시 확인:
1. `agy_cli=true` (env detection)
2. `_timeout 10 "$agy_cli_path" --version` (deterministic binding — Stage 1 detected path, NOT 리터럴 `agy`)
3. 실패 시 `not_attempted: agy_preflight_failed` 표시 후 reviewer 제외, N-way 합성 진행

`agy_cli=false` 시 1회 안내 (config 의 `agy_notified` flag 로 관리):
> "Antigravity CLI(agy)를 설치하면 Gemini 3.5 cross-vendor 검증이 활성화됩니다. 설치: https://antigravity.google/docs"

## 호출 패턴

`hooks/scripts/run-agy-reviewer.sh` 를 백그라운드 호출:

```bash
"$CLAUDE_PLUGIN_ROOT/hooks/scripts/run-agy-reviewer.sh" \
  --binary "$agy_cli_path" \
  --project-root "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" \
  --prompt-file "$prompt_file" \
  --output "$output_file" \
  --timeout-seconds 900
```

Bridge 가 자체 `_timeout` / `_sha256` shim 보유 + `set -Eeuo pipefail` 안전한 `|| rc=$?` 캡처 (R7 fixes).

Reviewer prompt 페이로드는 Opus / Codex 와 동일 (diff + rules.yaml + fitness.json + health_report + contract). Adversarial focus_text 는 agy 에 전달 안 함 — agy 는 standard review persona.

## Status 매트릭스

| AGY_STATUS | 조건 | 사용자 안내 |
|---|---|---|
| success | exit 0 + non-empty stdout | (없음) |
| timeout | exit 124 (perl SIGALRM trap 적용) | "agy가 900초 안에 응답하지 않았습니다. 나머지 reviewer로 합성을 계속합니다." |
| not_authenticated | exit ≠ 0 + stderr matches `AGY_AUTH_REGEX` | "agy 인증이 필요합니다. 터미널에서 `!agy` 실행 후 로그인하세요." |
| failed | 기타 비-0 exit 또는 empty stdout (rc=0) | stderr 마지막 5줄 리포트 첨부 |
| not_attempted | `agy_cli=false` OR `agy_enabled=false` OR preflight 실패 | (none) |

`AGY_AUTH_REGEX` 는 `run-agy-reviewer.sh` 의 단일 상수. 첫 실행 시 unauthenticated agy stderr 실측 후 refine (§4.2 spec 참조).

## N-way 합성 (agy 추가 시)

| N_actual | 패턴 | 처리 |
|---|---|---|
| 4 | 4/4 일치 | 🔴 high → REQUEST_CHANGES (annotation: `agreement: unanimous_4`) |
| 4 | 3/4 일치 | 🔴 high (annotation: `dissenter`, `dissenter_family`, `dissent_summary`) |
| 4 | 2/4 일치 | 🟡 CONCERN |
| 4 | 1/4 단독 | 참고 (single-reviewer note) |
| 4 | 0/4 | 🟢 APPROVE |

N=3, 2, 1 fallback 표는 `codex-integration.md` 참조 — agy 가 없을 때 동일.

## Mutation Protocol 참조

agy 는 **mutation 과 직교** — `--add-dir` filesystem walk 으로 gitignored 파일도 자연스럽게 봄. Mutation gating 조건 `(codex_plugin=true AND is_git=true)` 는 **변경 없음**. agy 로 인해 mutation 이 트리거되지 않음 (R5/R6 fix). 자세한 rationale: spec §3.3.

## Permanent opt-out

`.deep-review/config.yaml` 의 `agy_enabled: false` → reviewer enumeration 에서 agy 제외, 설치 여부와 무관. README 에 명시.
