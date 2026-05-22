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
| mutated | pre/post worktree fingerprint mismatch (C3 detection) | "⚠️ agy mutated workspace — manually verify before trusting review output." + `git status` 출력. agy 결과는 N_actual에서 제외. |
| prompt_too_large | 프롬프트 크기 > 200KB → 잘림 (W3) | agy 결과는 N_actual에서 제외 (부분 리뷰 신뢰 불가). |
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

## Fingerprint modes (v1.7.1+)

`agy_fingerprint_mode` in `.deep-review/config.yaml` (or `AGY_FINGERPRINT_MODE` env var) selects the mutation-detection mechanism. Default: `hybrid`.

| Mode | Mechanism | Coverage | Cost (large repo) | When to use |
|---|---|---|---|---|
| **hybrid** *(default)* | `git status -z` + per-dirty-file SHA-256 + sensitive-pattern walk via `lib/sensitive-patterns.list` | Tracked files, gitignored sensitive paths (.env, credentials, keys), already-dirty rewrites | ~0.4 s (100k files) | Most users |
| **full-walk** | SHA-256 of every non-excluded file (v1.7.0 behavior) | Everything except the standard exclusion list (`./.git/`, `./node_modules/`, `./dist/`, etc.) | ~60 s (100k files) | Strict-coverage users needing detection of user-defined gitignored paths outside the standard exclusion list |
| **git-status** | `git status -z` + per-dirty-file SHA-256 only (no sensitive scan) | Tracked files + already-dirty rewrites; **misses** gitignored sensitive paths | ~0.1 s | Tests, debugging |
| **off** | (no snapshot) | None | 0 | **DANGEROUS** — only when agy is known not to mutate the worktree |

**Resolution chain**: `AGY_FINGERPRINT_MODE` env var > config field > built-in default `hybrid`. The orchestrator (`commands/deep-review.md`) resolves before invoking the bridge; the bridge receives the resolved value via `--mode`.

**Degrade paths** (all append a one-line warning to `${output_file}.stderr-tail`):
- `lib/sensitive-patterns.list` missing → degrade **hybrid only** → full-walk (git-status mode does not read the list)
- `_sha256` backend absent → mode override to `off` + conservative `mutation_warning`
- `git status -z` failure → degrade hybrid/git-status → full-walk
- snapshot capture failure (pre or post) → conservative `mutation_warning` (post) or fresh full-walk (pre)

**C4 closed (v1.7.1)**: hybrid mode now appends per-file SHA-256 to each dirty/untracked `git status` line. An already-dirty tracked file rewritten by agy during the spawn window (` M foo` → ` M foo` with different content) is detected via content hash divergence.

**C5 trade-off (v1.7.1)**: hybrid mode misses agy writes to **user-defined gitignored paths outside the bridge's standard exclusion list**. Paths inside the standard list (`./dist/`, `./build/`, `./node_modules/`, etc.) are missed by **both** modes (never walked in v1.7.0 either). Set `agy_fingerprint_mode: full-walk` for user-defined gitignored paths outside the standard list.

**Known limitation (v1.7.2 deferred)**: hybrid's sensitive scan uses `find -iname` which matches basenames only. Gitignored sensitive files whose token appears only in a directory name (e.g., `./secrets/config.json`) are not detected.

**Repo precondition**: hybrid's "sibling reviewer writes to `.deep-review/reports/` produce no warning" property assumes the target repo has `.deep-review/` in its `.gitignore` (the standard /deep-review usage convention). Without that, sibling-reviewer writes will appear as untracked in `git status` and hybrid will correctly flag them.

## Permanent opt-out

`.deep-review/config.yaml` 의 `agy_enabled: false` → reviewer enumeration 에서 agy 제외, 설치 여부와 무관. README 에 명시.

## Security considerations

agy runs with `--dangerously-skip-permissions`, granting it filesystem **write** capability over
the full project tree (via `--add-dir`). `mutation-protocol.sh` only gates Codex git-index
mutations, so any agy write would be undetected by the existing protocol.

**Mitigation (v1.7.0)**: `run-agy-reviewer.sh` takes a coarse SHA-256 fingerprint of the
worktree before and after agy runs. If the hashes differ, it emits a warning to stderr and writes
`${output_file}.mutation-warning`. This fingerprint is **not cryptographically authoritative** —
it can miss renames, races on large trees, or files excluded from the scan. It is a best-effort
early warning. A future release may add git-status diffing for higher fidelity.

## Known limits (ARG_MAX)

`agy -p "$(cat $prompt_file)"` expands the full prompt into a process argument, which is
visible in `ps` output and subject to OS ARG_MAX limits (~256KB on macOS, ~2MB on Linux).
`run-agy-reviewer.sh` truncates prompts exceeding 200KB with a warning.

If agy adds a `--prompt-file <path>` flag in a future version, switch to that to eliminate
both the exposure and the size risk.

## Known assumptions (v1.7.0)

- `agy --print-timeout` is assumed to honor the value passed; behavior unverified at agy v1.0.0.
  The outer `_timeout` shim (fork/wait pattern, exit 124) is the **primary** safety net.
- `AGY_AUTH_REGEX` is provisional — to be refined from real unauthenticated agy stderr at first
  integration test. Current value covers common OAuth / session-expiry patterns.
- Worktree mutation fingerprint (C3) is coarse: races, large trees, excluded dirs (node_modules,
  .git, dist, build, etc.) reduce coverage. Flag any mutation warning to the user regardless.
