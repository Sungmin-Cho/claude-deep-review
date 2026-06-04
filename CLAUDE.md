# deep-review — Project Guide for Claude

Independent Evaluator for AI coding agents — runs a separate Opus subagent for cross-model code review (with optional Codex 최대 4-way verification), Sprint Contract verification, entropy scanning, and a structured 6-phase response protocol for evidence-based feedback handling.

For detailed version history see [`CHANGELOG.md`](CHANGELOG.md). This file is intentionally short — it holds the overview, structure, and drift-resistant conventions only.

To check the current version: `jq -r .version .claude-plugin/plugin.json`

> 📄 Documentation in this repo follows `docs/DOCS_RULE.md` (local maintainer guide — single-source-of-truth rules for README / CHANGELOG / this file).

---

## Project Overview

**deep-review** is a [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin that reviews changes through a separate evaluator subagent — never the Generator. Inspired by Anthropic's [Harness Design](https://www.anthropic.com/engineering/harness-design-long-running-apps), it structurally eliminates self-approval bias through Generator-Evaluator separation. When the Codex plugin is installed it expands into 최대 4-way parallel review (Opus + Codex review + Codex adversarial + agy); agy is included only when the agy CLI is detected.

**The 5-stage review pipeline** runs in fixed order:
1. **Collect** — git state detection (`change_state`, `review_base`, diff content)
2. **Contract Check** — load `.deep-review/contracts/*.yaml` (status: active), verify each criterion
3. **Deep Review** — spawn the Opus subagent + optional Codex (review + adversarial) + optional agy in parallel
4. **Verdict** — synthesize findings into `APPROVE` / `CONCERN` / `REQUEST_CHANGES`
5. **Respond** (optional via `--respond`) — 6-phase READ / UNDERSTAND / VERIFY / EVALUATE / RESPOND / IMPLEMENT, with the IMPLEMENT phase delegated to a dedicated `phase6-implementer` Sonnet subagent

**Marketplace presence**: One of six plugins in the [claude-deep-suite](https://github.com/Sungmin-Cho/claude-deep-suite) marketplace.

---

## 🚨 CRITICAL — Plugin Update Workflow

**Every deep-review release must be accompanied by the following work. No exceptions.**

### 1. Sync the deep-suite marketplace (required)

Update the following in `/Users/sungmin/Dev/claude-plugins/deep-suite/`:

- **`.claude-plugin/marketplace.json`** and **`.agents/plugins/marketplace.json`** — under the `deep-review` entry: `sha` = full 40-character merge commit hash on the new `main`; description = one-line headline summary.
- **`README.md`** / **`README.ko.md`** — the `deep-review` row in the Plugins table and any narrative sections that reference the version.

After editing:
```bash
cd /Users/sungmin/Dev/claude-plugins/deep-suite
git add .claude-plugin/marketplace.json .agents/plugins/marketplace.json README.md README.ko.md
git commit -m "chore: bump deep-review to vX.Y.Z — <one-line summary>"
git push
```

### 2. Update deep-review CHANGELOG (required)

- Add a new version entry to `CHANGELOG.md`
- Bump the version in `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, and `package.json`

**Do NOT inline release notes in this CLAUDE.md** — CHANGELOG is the single source of truth.

---

## Directory Structure

```
deep-review/
├── .claude-plugin/plugin.json
├── .codex-plugin/plugin.json     # plugin manifest
├── package.json                    # npm manifest (Node 20+, node:test runner)
├── agents/
│   ├── code-reviewer.md           # Opus subagent (spawned by /deep-review, Stage 3)
│   └── phase6-implementer.md      # Sonnet subagent (dispatched by /deep-review --respond Phase 6)
├── commands/
│   └── deep-review.md             # main command — 4-stage review pipeline + Stage 5 respond
├── hooks/
│   ├── hooks.json                 # empty (no active hooks since v1.3.1)
│   └── scripts/
│       ├── detect-environment.sh  # Stage 1: git state + codex / claude_cli / agy probes
│       ├── mutation-protocol.sh   # Codex auto-exposure lock / mutation / recovery protocol
│       ├── run-claude-reviewer.sh # Claude CLI bridge — Opus reviewer for Codex / non-Claude runtimes
│       ├── run-agy-reviewer.sh    # agy CLI bridge — 4th reviewer (v1.7.0+); own _timeout / _sha256 / pre+post fingerprint
│       ├── envelope.js            # M3 envelope library (zero-dep CommonJS)
│       ├── wrap-recurring-findings-envelope.js  # CLI for recurring-findings emission
│       └── test/
│           ├── test-mutation-protocol.sh         # 54 assertions, macOS + ubuntu CI
│           ├── test-detect-environment.sh        # CI: env probes (codex / claude_cli / agy)
│           ├── test-codex-claude-reviewer.sh     # CI: run-claude-reviewer.sh bridge
│           ├── test-run-agy-reviewer.sh          # CI: agy bridge classifier + fingerprint
│           ├── test-phase6-subagent.sh           # agents/phase6-implementer.md frontmatter contract
│           └── test-phase6-protocol-e2e.sh       # E1–E12 structural + protocol tests
├── scripts/
│   └── validate-envelope-emit.js  # release-lint (mirrors suite envelope schema)
├── skills/
│   ├── deep-review-workflow/      # Stage 3 review logic, Codex / agy integration references
│   │   └── references/
│   │       ├── review-criteria.md     # Correctness, Architecture, Entropy, Test coverage, Readability
│   │       ├── contract-schema.md     # Sprint Contract YAML shape + auto/manual/mixed verification
│   │       ├── report-format.md       # Findings output (🔴 Critical, 🟡 Warning, ℹ️ Info) + dissenter annotation
│   │       ├── codex-integration.md   # Preflight, 최대 4-way parallel, timeout/auth handling
│   │       └── agy-integration.md     # 4th reviewer — trust-boundary, status matrix, fingerprint mitigation
│   ├── deep-review-loop/          # v1.6.0+ — user-invocable skill: review ↔ respond auto-iteration (was commands/deep-review-loop.md in v1.5.x)
│   │   └── SKILL.md
│   └── receiving-review/          # Stage 5 response protocol
│       └── references/
│           ├── response-protocol.md       # 6-phase workflow + source-trust matrix
│           ├── phase6-delegation-spec.md  # Subagent contract + Phase 6 group loop
│           ├── phase6-prompt-contract.md  # Main → subagent Accepted-Items format
│           ├── forbidden-patterns.md      # Guard against path traversal / injection in log paths
│           └── response-format.md         # Per-item evidence, accept/reject/defer decision log
├── tests/
│   ├── envelope-emit.test.js      # 45 cases (generateUlid, wrap/unwrap, CLI)
│   ├── envelope-chain.test.js     # 42 cases (parent_run_id chain, identity guards)
│   └── fixtures/
│       └── sample-recurring-findings.json
├── .github/workflows/tests.yml    # CI: envelope tests + phase6 protocol on ubuntu + macos
├── .gitignore                      # config.yaml, reports/, responses/, entropy-log.jsonl, .pending-mutation.json
├── CHANGELOG.md
└── README.md
```

---

## Key Concepts

### M3 envelope — `recurring-findings.json`

`.deep-review/recurring-findings.json` is emitted as an M3 cross-plugin envelope (no longer a legacy top-level `findings[]`):

```json
{
  "schema_version": "1.0",
  "envelope": {
    "producer": "deep-review",
    "producer_version": "<from plugin.json>",
    "artifact_kind": "recurring-findings",
    "run_id": "<ULID>",
    "generated_at": "<RFC 3339>",
    "schema": { "name": "recurring-findings", "version": "1.0" },
    "parent_run_id": "<consumed session-receipt run_id>",
    "git": { "head": "<sha>", "branch": "<name>", "dirty": <bool> }
  },
  "payload": { "findings": [...], "taxonomy_version": "<v>", "updated_at": "<RFC 3339>" }
}
```

**Identity contract** — `unwrapEnvelope()` enforces a 3-way guard: `producer === "deep-review"`, `artifact_kind === "recurring-findings"`, `schema.name === "recurring-findings"`. Foreign envelopes or mismatched identity → silent `null` with stderr warning (downstream treats as "no data"; do NOT silently trust). Pre-1.4.0 readers using `jq '.findings[]'` against the legacy top-level array will see nothing — upgrade to envelope-aware unwrap before reading `payload.findings`.

**Chain** — `recurring-findings.envelope.parent_run_id` is set to the consumed `session-receipt.envelope.run_id` during Stage 3.

### Sprint Contract schema

```yaml
slice: SLICE-NNN
title: <string>
status: active | archived
criteria:
  - id: C1 | C2 | ...
    description: <string>
    verification: auto | manual | mixed
    status: null              # ← filled by Evaluator: PASS | FAIL | PARTIAL | SKIP
    evidence: null            # ← filled by Evaluator
```

**Invariant**: contracts with `status: active` are auto-loaded on every `/deep-review` invocation (no flag needed). Archived contracts are excluded unless explicitly named via `--contract <SLICE-NNN>`.

### Recurring findings taxonomy

Seven categories: `error-handling`, `naming-convention`, `type-safety`, `test-coverage`, `security`, `performance`, `architecture`.

- A finding becomes "recurring" when the same category appears **3+ times** across reports
- Severity is promoted to the maximum if mixed within a category
- Emitted once **2+ reports** exist in `.deep-review/reports/`

### Mutation lock protocol (Codex auto-exposure)

- **Lock dir**: `.deep-review/.mutation.lock/` (atomic `mkdir`, POSIX-portable)
- **State file**: `.deep-review/.pending-mutation.json` (`schema_version: 1`; tracks intent-to-add entries, sensitive files, restoration targets)
- **Stale window**: `REVIEW_TIMEOUT_SECONDS=1200` (must remain `> codex_timeout` to avoid misclassifying active reviewers as orphaned; current codex timeout is 900s)
- **Recovery**: auto-triggered on `/deep-review` entry; validates lock mtime, restores user staging, cleans own intent-to-add entries, releases lock
- **Sensitive patterns**: `.env*`, `credentials*`, `*secret*`, `.key`, `.pem`, `.netrc`, `.pgpass`, `wrangler.toml`, JWT (scanned case-insensitively; all-sensitive set auto-skipped)
- **agy is orthogonal to this lock** — `run-agy-reviewer.sh` ships its own coarse pre/post SHA-256 worktree fingerprint (`--add-dir` walks filesystem, not git index). On mismatch it emits `${output_file}.mutation-warning` and the reviewer is excluded from N-way synthesis. Mutation gating condition `(codex_plugin=true AND is_git=true)` is unaffected by agy. See `skills/deep-review-workflow/references/agy-integration.md`.

### Phase 6 delegation

**Main session** owns Phases 1–5 (READ → UNDERSTAND → VERIFY → EVALUATE → RESPOND) and decides accept / reject / defer. It builds an `implementation_guide` per accepted item.

**`phase6-implementer` subagent** (model: sonnet) receives only **Accepted Items** in severity group order (critical → warning → info). Per-item shape:

```yaml
item_id: <string>
title: <string>
severity: critical | warning | info
confidence: agreed | partial
source: opus | codex-review | codex-adversarial | agy | Human | PR comment (@author, #id)
file_refs: [path, ...]
issue_summary: <string>
implementation_guide:
  target_location: <file:line-range>
  modifiable_paths: [<companion files>]
  intent: <string>
  change_shape: <string>
  non_goals: [<string>, ...]
  acceptance: <test command>
```

Phase 6 `source` enum: `opus | codex-review | codex-adversarial | agy | Human | PR comment (@author, #id)` — `agy` is **appended** to the existing enum, not replacing other values.

The subagent only does **execution mechanics** (Edit, test, commit). If the `implementation_guide` is ambiguous, it sets `status: error` on that item and continues — it never re-evaluates accept/reject decisions.

**Main-session Step 5 verification** — compares the post-implement git diff (`git hash-object` per file) against the allowlist (DELTA). NEW_PATHS / REVERTED mismatches → `execution_status=error`; recovers from per-file content baselines in `.deep-review/tmp/phase6-<severity>-baseline/`. Preserves the tracked-but-deleted WIP distinction (` D` vs `D `).

**Log paths**: `log_path` must be a single-quoted absolute path. Forbidden: `printf '%q'` pre-quoting, `"$log_path"` inside `'...'`, unquoted paths with spaces.

### Configuration state

- **Per-machine** (`.gitignore`d): `.deep-review/config.yaml`, `reports/`, `responses/`, `entropy-log.jsonl`, `.pending-mutation.json`
- **Shared** (tracked): `.deep-review/rules.yaml` (inferential style/architecture rules), `contracts/`, `fitness.json` (deep-work health rules)

**agy-related config flags** (all stored in `.deep-review/config.yaml`):
- `agy_notified: false` — 1-time install hint suppression
- `agy_enabled: true` — permanent opt-out (set false to skip agy regardless of detection)
- `agy_sensitive_acked_fingerprint: ""` — SHA-256 of last-acked sensitive-file scan (§4.5.1)
- `agy_fingerprint_mode: hybrid` — fingerprint mode (`hybrid` | `full-walk` | `git-status` | `off`). v1.7.1+. Default `hybrid`. Override via `AGY_FINGERPRINT_MODE` env var (e.g., CI pinning). See [`agy-integration.md`](skills/deep-review-workflow/references/agy-integration.md) "Fingerprint modes" for cost/coverage table.
- `agy_model: "Gemini 3.5 Flash (High)"` — agy model tier (v1.9.0). Resolution: `AGY_MODEL` env > config > default `Gemini 3.5 Flash (High)`. Review is a bounded read task, so a Flash tier cuts agy's dominant cost (Gemini inference round-trip) vs the Pro default. **Injection-safe**: free-form value, so the orchestrator resolves it as a shell variable and passes `--model "$agy_model"` (never a `{placeholder}` literal — unlike enum-validated `--mode`) behind a charset allowlist (`[A-Za-z0-9 ._/()-]`) that falls back to default; the bridge keeps the same guard as defense-in-depth. Quoted or unquoted config both work; `agy_model: ""` uses agy's own default. The bridge does **not** pre-call `agy models` (a ~3 s backend call) — an unknown tier is forwarded and, if agy rejects it, that reviewer is excluded.

---

## Workflows & Conventions

### macOS bash 3.2 portability (required)

Run on both `ubuntu-latest` (GNU bash 5, GNU stat -c, GNU awk/sed) and `macos-latest` (bash 3.2, BSD stat -f, BSD awk/sed). Avoid `declare -A` (use TSV temp files + `awk -F'\t'` lookups), `mapfile`, `globstar`. All scripts use `set -Eeuo pipefail`.

**GNU `stat -f` is NOT BSD `stat -f`** — on Linux it means "filesystem status," and `%m` returns a mount-point string. Always order: GNU first (`stat -c %Y`), BSD fallback (`stat -f %m`). Pre-v1.4.2 ordering caused arithmetic failures on Linux. Comment the order rationale at every call site.

### UTC ISO 8601 timestamps (required)

All `generated_at`, `created_at`, and `last_review` stored as `YYYY-MM-DDTHH:MM:SSZ` (Z suffix). Use `date -u +"%Y-%m-%dT%H:%M:%SZ"`.

### Codex `_timeout` shim

```bash
_timeout() {
  local seconds="$1"; shift
  if command -v gtimeout &>/dev/null; then gtimeout "$seconds" "$@"
  elif command -v timeout &>/dev/null; then timeout "$seconds" "$@"
  else perl -e "alarm $_[0]; exec @_[1..$#_]" "$@"
  fi
}
```

Per-call value is 900s (set at the top of `mutation-protocol.sh`); per-review lock timeout is 1200s (must stay > per-call timeout).

---

## Slash commands & user-invocable skills

| Entry | Kind | Description |
|---|---|---|
| `/deep-review` | command | Review current changes with the Opus subagent (Codex + agy optional, up to 4-way) |
| `/deep-review --contract [SLICE-NNN]` | command | Sprint Contract-based verification |
| `/deep-review --entropy` | command | Entropy scan → `.deep-review/entropy-log.jsonl` |
| `/deep-review --respond <REPORT_PATH>` | command | 6-phase response protocol on a saved report |
| `/deep-review --respond --source=pr --pr=<N>` | command | Collect GitHub PR comments via `gh api` and respond |
| `/deep-review init` | command | Interactive setup of `.deep-review/rules.yaml` + `.gitignore` |
| `/deep-review-loop [--max=N]` *(v1.6.0+)* | **skill** (`skills/deep-review-loop/`) | Auto-iterate review ↔ respond until convergence. Migrated from a slash command to a `user-invocable: true` skill so Codex CLI and other SDK consumers can invoke it via `Skill({ skill: "deep-review:deep-review-loop" })` — slash entry `/deep-review-loop` keeps working in Claude Code. |

---

## Tests

```bash
npm test
# → node --test on tests/envelope-{emit,chain}.test.js (87 cases)

bash hooks/scripts/test/test-mutation-protocol.sh  # 54 assertions
bash hooks/scripts/test/test-phase6-protocol-e2e.sh  # E1–E12 scenarios
```

CI matrix: `ubuntu-latest` + `macos-latest`. Triggers on main push + PRs touching `agents/`, `commands/deep-review.md`, `skills/**`, `tests/`, or the workflow itself.

---

## Quick references

| Question | Answer |
|---|---|
| Stale `.mutation.lock`? | `auto_recover()` validates mtime against `REVIEW_TIMEOUT_SECONDS`; manual `rm -rf` only if certain no active reviewer |
| `phase6-implementer` returned `status: error`? | Ambiguous `implementation_guide` — refine it on the main side and re-dispatch that severity group |
| Recurring findings missing? | Need 2+ reports in `.deep-review/reports/`, and category must appear 3+ times |
| Cross-plugin chain broken? | `recurring-findings.envelope.parent_run_id` must mirror the consumed session-receipt's `run_id` from Stage 3 |
| Partial-hunk staging lost during recovery? | Step 7 emits a warning — re-run `git add -p` manually; full hunk restore is deferred |
| agy emitted `${output_file}.mutation-warning`? | Bridge detected worktree SHA-256 drift between pre/post spawn — agy result is excluded from N-way synthesis. Investigate with `git status`; coarse fingerprint may miss renames/races. See `agy-integration.md` Status Matrix. |
| agy reviewer noticeably slower than Opus / Codex? | The dominant cost is agy's **Gemini inference round-trip** (the CLI itself, ~94% network wait), NOT the bridge — so v1.9.0 added `agy_model` (default `Gemini 3.5 Flash (High)`) to pin a faster tier; set a Flash tier (or `AGY_MODEL` env) to cut it, or `agy_enabled: false` to drop agy from the default fan-out. SECONDARY (now fixed): the hybrid fingerprint's `build_find_expr` fork storm cost ~4.5 s/build ×2 — v1.9.0 de-fork + memoization cut it to ~0.08 s (~56×), so hybrid stays the default with full coverage. `agy_fingerprint_mode: full-walk` restores v1.7.0 whole-tree hashing. |

---

## Related repositories

- **deep-suite (marketplace)**: https://github.com/Sungmin-Cho/claude-deep-suite — `/Users/sungmin/Dev/claude-plugins/deep-suite`
- **deep-work**: https://github.com/Sungmin-Cho/claude-deep-work
- **deep-wiki**: https://github.com/Sungmin-Cho/claude-deep-wiki
- **deep-evolve**: https://github.com/Sungmin-Cho/claude-deep-evolve
- **deep-docs**: https://github.com/Sungmin-Cho/claude-deep-docs
- **deep-dashboard**: https://github.com/Sungmin-Cho/claude-deep-dashboard

---

**🔁 Reminder**: This CLAUDE.md is intentionally kept short. For every new release:

1. **Write the details in CHANGELOG** (not here — prevents drift)
2. **Only sync the schema sections** (envelope shape, Sprint Contract, mutation lock, Phase 6 contract) if the schema itself changed
3. **Sync the deep-suite marketplace** (see the "CRITICAL" section above)
