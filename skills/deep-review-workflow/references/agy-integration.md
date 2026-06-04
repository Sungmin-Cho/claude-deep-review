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

`hooks/scripts/run-agy-reviewer.sh` 를 백그라운드 호출. **`--mode`** 인자는 호출자(orchestrator)가 env→config→default 체인으로 미리 해결해서 전달해야 한다. bridge 자체의 내부 default(`hybrid`)에만 의지하면 사용자의 `AGY_FINGERPRINT_MODE` env var이나 config 설정이 무시된다 (impl-r4 Codex adv MED).

```bash
# 호출자가 resolution 체인 적용 (orchestrator pattern)
mode="${AGY_FINGERPRINT_MODE:-}"
if [ -z "$mode" ] && [ -f .deep-review/config.yaml ]; then
  mode=$(sed -nE 's/^agy_fingerprint_mode:[[:space:]]*["'\'']?([^"'\''#[:space:]]+)["'\'']?.*$/\1/p' .deep-review/config.yaml | head -1)
fi
mode="${mode:-hybrid}"

# v1.9.0: model tier — resolved IN-SHELL, passed as a shell variable (never
# literal-substituted). agy_model is free-form text from (possibly untrusted)
# config, so unlike the enum-validated $mode it must be expanded as "$agy_model"
# with a charset allowlist guard — splicing it into a command string would be a
# shell-injection vector.
agy_model="${AGY_MODEL:-}"
if [ -z "${AGY_MODEL:-}" ]; then
  if [ -f .deep-review/config.yaml ] && grep -qE '^agy_model:' .deep-review/config.yaml; then
    raw=$(grep -E '^agy_model:' .deep-review/config.yaml | head -1 | sed -E 's/^agy_model:[[:space:]]*//')
    case "$raw" in
      \"*) agy_model=${raw#\"}; agy_model=${agy_model%%\"*} ;;             # double-quoted
      *)   agy_model=${raw%%#*}; agy_model="${agy_model%"${agy_model##*[![:space:]]}"}" ;;  # unquoted scalar
    esac
    # (single-quoted YAML values are not parsed; they trip the charset guard below
    #  and fall back to the default — quote with " or leave unquoted.)
  else
    agy_model="Gemini 3.5 Flash (High)"
  fi
fi
case "$agy_model" in
  "") : ;;                                                # opt-out → omit --model
  *[!A-Za-z0-9\ ._/\(\)-]*) agy_model="Gemini 3.5 Flash (High)" ;;   # charset guard → default
esac
agy_model_args=(); [ -n "$agy_model" ] && agy_model_args=(--model "$agy_model")

"$CLAUDE_PLUGIN_ROOT/hooks/scripts/run-agy-reviewer.sh" \
  --binary "$agy_cli_path" \
  --project-root "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" \
  --prompt-file "$prompt_file" \
  --output "$output_file" \
  --mode "$mode" \
  "${agy_model_args[@]+${agy_model_args[@]}}" \
  --timeout-seconds 900
```

## Model tier (v1.9.0)

agy 의 wall-clock 비용 대부분은 **Gemini 추론 네트워크 왕복**이다 (브릿지가 아님 — 사소한 1단어 프롬프트도 ~10s, ~94%가 네트워크 대기; Go 바이너리 콜드 스타트는 ~0.05s). 리뷰는 bounded read 작업이므로 최상위 추론 티어가 필요 없다. 그래서 v1.9.0 은 `--model` 패스스루를 도입해 **빠른 Flash 티어를 기본**으로 핀한다.

- **Resolution**: `AGY_MODEL` env var > `.deep-review/config.yaml` 의 `agy_model` 필드 > 빌트인 기본값 `Gemini 3.5 Flash (High)`.
- **Config (인용/비인용 모두 허용)**:
  ```yaml
  agy_model: "Gemini 3.5 Flash (High)"   # 기본값 (인용 권장)
  # agy_model: Gemini 3.1 Pro (Low)      # 비인용 스칼라도 허용 (trailing comment 제거)
  # agy_model: ""                         # opt-out → agy 자체 기본 티어 (--model 생략)
  ```
- **🔒 Injection-safety (v1.9.0 Codex P1 fix)**: `agy_model` 은 free-form 값이고 신뢰할 수 없는 repo 가 config 를 ship 할 수 있으므로, orchestrator 는 enum 인 `--mode` 와 달리 model 을 **`{placeholder}` 리터럴로 치환하지 않는다**. bridge 호출과 같은 Bash 세션에서 shell 변수로 해석해 `--model "$agy_model"` 로 전개하고, charset allowlist (`[A-Za-z0-9 ._/()-]`) 를 벗어나는 값은 기본 티어로 폴백한다. bridge 도 같은 charset 가드를 defense-in-depth 로 갖는다 (`--model` 은 argv 로 전달 — bridge 자체엔 injection 없음).
- **No `agy models` pre-call (v1.9.0 perf)**: `agy models` 는 백엔드를 쳐서 ~3s/run 이 든다. bridge 는 이를 호출하지 않는다. charset 만 통과하면 그대로 전달하고, agy 가 알 수 없는 티어를 거부하면 그 리뷰어는 `failed` 로 분류되어 합성에서 제외된다 (다른 리뷰어와 동일). 따라서 티어 typo/rename 은 "agy 제외"로 가시화된다 — 잘못된 값으로 조용히 진행하지 않는다.
- **빈 값(`""`)**: charset 케이스의 `""` 분기 + bridge 의 `[ -n "$model" ]` → `--model` 생략 → agy 자체 기본 티어 사용.

Bridge 가 자체 `_timeout` / `_sha256` shim 보유 + `set -Eeuo pipefail` 안전한 `|| rc=$?` 캡처 (R7 fixes).

Reviewer prompt 페이로드는 Opus / Codex 와 동일 (diff + rules.yaml + fitness.json + health_report + contract). Adversarial focus_text 는 agy 에 전달 안 함 — agy 는 standard review persona.

**Read-only 강제 (v1.8.1+)**: `run-agy-reviewer.sh` 가 orchestrator 가 작성한 prompt body 앞에 **read-only preamble 을 무조건 prepend** 한다 (단일 choke point). agy CLI 는 read-only 모드가 없고 — `-p` 가 권한 플래그 유무와 무관하게 Edit/Write 를 자동 승인하며 (`--dangerously-skip-permissions` 제거도 `--sandbox` 추가도 파일 write 를 막지 못함, 실측 확인), `--sandbox` 는 터미널/쉘만 제한 — 합성(Stage 4) **전에** agy 가 코드를 수정하는 것을 막는 **유일한 신뢰 가능 사전 방어선이 prompt-level 지시**이기 때문이다. preamble 은 "파일 생성/수정/삭제/이동, git mutation, 상태 변경 쉘 명령 금지 — 분석·리포트만, 수정 제안은 산문으로" 를 명령조로 강제한다. preamble 을 무시하고 agy 가 수정하면 pre/post fingerprint 가 탐지 (`AGY_STATUS=mutated`, N-way 합성 제외) 하는 사후 방어선(defense-in-depth)이 그대로 작동한다. orchestrator 가 어떤 prompt 를 쓰든 bridge 가 강제하므로, prompt 작성 측의 누락에 의존하지 않는다.

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
| **hybrid** *(default)* | `git status -z` + per-dirty-file SHA-256 + sensitive-pattern walk via `lib/sensitive-patterns.list` + sidecar directory-match opt-ins | Tracked files, gitignored sensitive paths (.env, credentials, keys — basename matching, bilateral directory-name matching, and sidecar-enabled non-bilateral directory-name matching), already-dirty rewrites, plugin self-state (`.deep-review/config.yaml`, `.deep-review/.pending-mutation.json`) including bounded in-repo symlink targets | ~0.4 s (100k files) | Most users |
| **full-walk** | Sorted per-path fingerprints for every non-excluded file or symlink | Everything except the standard exclusion list (`./.git/`, `./node_modules/`, `./dist/`, etc.); symlink link-target swaps are detected via link target hex | ~60 s (100k files) | Strict-coverage users needing detection of user-defined gitignored paths outside the standard exclusion list |
| **git-status** | `git status -z` + per-dirty-file SHA-256 only (no sensitive scan) | Tracked files + already-dirty rewrites; **misses** gitignored sensitive paths | ~0.1 s | Tests, debugging |
| **off** | (no snapshot) | None | 0 | **DANGEROUS** — only when agy is known not to mutate the worktree |

**Performance (v1.9.0 — hybrid fork-storm fix)**: prior to v1.9.0, `build_find_expr` rebuilt the `find` OR-chain with a per-pattern subshell/fork storm — `_normalize_pattern_line` forked `tr`+`sed`, and `_is_dir_match_opted_in` re-opened AND re-normalized the entire dir-match sidecar **for every one of the 52 patterns** — costing ~4.5 s per build and running **twice** (pre + post spawn), so hybrid never met the ~0.4 s figure in the table above (it was effectively ~9 s of pure local CPU regardless of repo size). v1.9.0 de-forks normalization to bash parameter expansion, loads the sidecar **once** per build (`_load_dir_match_set`), and **memoizes** the expression across the pre/post snapshots — measured ~4.5 s → ~0.08 s per build (~56×). Output is byte-identical (verified by sha256 against a captured golden), so coverage is unchanged; the table costs now reflect reality. This is why hybrid remains the default (fast **and** retaining gitignored-sensitive-path coverage) rather than downgrading the default to `git-status`.

**Resolution chain**: `AGY_FINGERPRINT_MODE` env var > config field > built-in default `hybrid`. The orchestrator (`commands/deep-review.md`) resolves before invoking the bridge; the bridge receives the resolved value via `--mode`.

**Degrade paths** (all append a one-line warning to `${output_file}.stderr-tail`):
- `lib/sensitive-patterns.list` missing → degrade **hybrid only** → full-walk (git-status mode does not read the list)
- `lib/sensitive-patterns-dir-match.list` missing → preserve basename-only behavior for non-bilateral patterns
- UTF-8 BOM in `sensitive-patterns.list` → degrade **hybrid only** → full-walk; UTF-8 BOM in the sidecar → disable sidecar opt-ins with a warning
- `_sha256` backend absent → mode override to `off` + conservative `mutation_warning`
- `git status -z` failure → degrade hybrid/git-status → full-walk
- snapshot capture failure (pre or post) → conservative `mutation_warning` (post) or fresh full-walk (pre)

**C4 closed (v1.7.1)**: hybrid mode now appends per-file SHA-256 to each dirty/untracked `git status` line. An already-dirty tracked file rewritten by agy during the spawn window (` M foo` → ` M foo` with different content) is detected via content hash divergence.

**C5 trade-off (v1.7.1)**: hybrid mode misses agy writes to **user-defined gitignored paths outside the bridge's standard exclusion list** unless those paths match the sensitive-pattern scan. Paths inside the standard list (`./dist/`, `./build/`, `./node_modules/`, etc.) are missed by **both** modes. Set `agy_fingerprint_mode: full-walk` for user-defined gitignored paths outside the standard list.

### Sidecar-driven directory matching (v1.8.0)

`hooks/scripts/lib/sensitive-patterns.list` remains the literal shared pattern list read by both the bridge and `mutation-protocol.sh`. The bridge additionally reads `hooks/scripts/lib/sensitive-patterns-dir-match.list` for non-bilateral patterns that should match directory names. The shipped sidecar enables `credentials*` and `bearer_*`.

Matching is exact after stripping a leading `**/` from both lists. Blank lines and `#`-prefixed comments are ignored. Sidecar entries cause the bridge to emit both `-iname <pattern>` and `-ipath '*/<pattern>*/*'`; patterns not listed remain basename-only unless they are already bilateral `*X*` patterns. Sidecar comparison is exact-string, while the generated `find -iname` / `-ipath` predicates are case-insensitive.

### Symlink target snapshot (v1.8.0 — arms 1a/1b/1c)

The bridge now fingerprints files and symlinks through one shared helper. Runtime-state paths and sensitive-scan paths use the same sentinel forms:

- `symlink:<sha256-or-unavailable>:<linkhex>` for symlinks resolving to a regular target inside the project root at or below 16 KB.
- `symlink-unbounded:<linkhex>` for broken links, directory targets, external targets, non-regular targets, or targets larger than 16 KB.
- `symlink-readlink-failed` when `[ -L ]` is true but `readlink` fails.

The link target hex is the one-step `readlink` output, so target swaps with identical content are still detected. External target content changes are intentionally not detected; only the link target string is tracked to avoid environment-drift false positives.

**Repo precondition**: hybrid's "sibling reviewer writes to `.deep-review/reports/` produce no warning" property assumes the target repo has `.deep-review/` in its `.gitignore` (the standard /deep-review usage convention). Without that, sibling-reviewer writes will appear as untracked in `git status` and hybrid will correctly flag them.

## Permanent opt-out

`.deep-review/config.yaml` 의 `agy_enabled: false` → reviewer enumeration 에서 agy 제외, 설치 여부와 무관. README 에 명시.

## Security considerations

agy runs with `--dangerously-skip-permissions`, granting it filesystem **write** capability over
the full project tree (via `--add-dir`). `mutation-protocol.sh` only gates Codex git-index
mutations, so any agy write would be undetected by the existing protocol. Critically, agy CLI has
**no read-only mode**: empirical probing confirms `agy -p` auto-approves Edit/Write tool calls even
with no permission flag at all — removing `--dangerously-skip-permissions` does not block writes,
and `--sandbox` only restricts the terminal/shell, not filesystem-write tools. A general-purpose
agent handed a "review this" prompt will therefore happily *apply* the fixes it finds, mutating the
workspace **before** Stage 4 synthesis.

**Primary mitigation (v1.8.1) — prompt-level read-only directive**: `run-agy-reviewer.sh` prepends
a strict read-only preamble to the prompt body at a single bridge choke point (independent of the
orchestrator-supplied prompt). It forbids file creation/edit/delete/move, git mutation, and
state-changing shell commands, and instructs agy to describe fixes in prose only. This is the only
reliable *pre-spawn* prevention, since agy cannot be sandboxed into read-only at the CLI level.

**Backstop mitigation (v1.7.0) — post-spawn fingerprint**: `run-agy-reviewer.sh` takes a SHA-256
fingerprint of the worktree before and after agy runs (hybrid/full-walk/git-status modes). If the
hashes differ, it emits a warning to stderr and writes `${output_file}.mutation-warning`, and the
reviewer is excluded from N-way synthesis (`AGY_STATUS=mutated`). This catches the case where agy
ignores the preamble and writes anyway. The fingerprint is **not cryptographically authoritative** —
it can miss renames, races on large trees, or files excluded from the scan — so it is the second
line of defense, not the first.

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
