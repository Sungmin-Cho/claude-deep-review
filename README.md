**English** | [한국어](./README.ko.md)

# deep-review

![version](https://img.shields.io/github/package-json/v/Sungmin-Cho/claude-deep-review?label=version)
![license](https://img.shields.io/github/license/Sungmin-Cho/claude-deep-review)
[![part of deep-suite](https://img.shields.io/badge/part%20of-deep--suite-5b8def)](https://github.com/Sungmin-Cho/claude-deep-suite)

An independent Evaluator plugin for AI coding agents — cross-model code review with Codex integration and Sprint Contract support.

AI coding agents have a structural blind spot: they review their own work. The agent that wrote the code also judges it, so self-approval bias is built in. deep-review runs a **separate reviewer context** that sees the shared review payload — not the reasoning, intentions, or assumptions behind the code — for a structurally independent evaluation. Claude Code can use an Opus named agent, while Codex can use its native generic subagent; optional Codex companion and `agy` roles extend this into parallel cross-model verification.

## Role in deep-suite

deep-review is the **independent evaluator** of the [claude-deep-suite](https://github.com/Sungmin-Cho/claude-deep-suite), implementing the Generator–Evaluator separation from the [Harness Engineering](https://martinfowler.com/articles/harness-engineering.html) framework:

- **Inferential sensor** — an independent Opus subagent review with zero Generator context, the primary quality gate for semantic issues computational sensors cannot catch.
- **Cross-model verification** — Opus + Codex review + Codex adversarial (+ agy), exceeding the framework's "LLM-as-judge" concept.
- **Fitness-aware review** — consumes `fitness.json` rules and the `health_report` from [deep-work](https://github.com/Sungmin-Cho/claude-deep-work) for architecture-intent-aware evaluation.
- **Sprint Contract verification** — structured success-criteria checking.

## Install

Via the `claude-deep-suite` marketplace:

```bash
# Claude Code
/plugin install deep-review@claude-deep-suite

# Codex
codex plugin install deep-review
```

No additional configuration is required. On first run, `.deep-review/` is created with a default `config.yaml`. Run `/deep-review init` to generate a project-specific `rules.yaml`.

The supported runtime is zero-dependency Node.js 22 with Git 2.45 or newer on macOS, Linux, and native Windows 11. Git Bash is not a prerequisite.

## Usage

Claude Code slash commands and Codex skills are distinct host entrypoints for the same route grammar.

### Claude Code

| Command | Description |
|---|---|
| `/deep-review` | Review current changes with an independent Opus subagent (cross-model when Codex/agy are present) |
| `/deep-review --ultracode [--codex]` | Six focused Claude reviewer contexts collapsed into one "Claude(ultracode)" voice, with a visible single-bridge fallback and optional Codex roles |
| `/deep-review --codex-only` | Disable the Claude reviewer and run only the available Codex roles |
| `/deep-review --contract [SLICE-NNN]` | Sprint Contract-based structural verification |
| `/deep-review --entropy` | Entropy scan (duplicates, pattern drift, naming mismatches) |
| `/deep-review --respond [REPORT_PATH]` | Respond to review findings with the evidence-based protocol |
| `/deep-review --respond --source=pr` | Respond to GitHub PR review comments |
| `/deep-review-loop [--max=N]` | Auto-iterate review ↔ respond until convergence (also a `user-invocable` skill — `Skill({ skill: "deep-review:deep-review-loop" })` for Codex CLI / SDK consumers) |
| `/deep-review-loop --ultracode --codex` | ultracode once (round 1) + codex every round integrated loop |
| `/deep-review-loop --session-doc` | Maintain one consolidated per-session review document, re-rendered in place after each round (per-round reports unchanged) |
| `/deep-review --dry-run` / `--explain-routing` | Classify review targets deterministically and print the plan without running any reviewer (artifact-aware routing Phase 1) |
| `/deep-review init` | Initialize per-project review rules interactively |

### Codex

| Skill | Description |
|---|---|
| `$deep-review:deep-review` | Review current changes with the same flags and synthesis rules as `/deep-review` |
| `$deep-review:deep-review --respond [REPORT_PATH]` | Run the evidence-based response protocol |
| `$deep-review:deep-review-loop [--max=N]` | Alternate review and response until convergence |

**Composable reviewer flags**:

- `--ultracode` — six focused Claude reviewer contexts collapsed into one "Claude(ultracode)" voice; an unavailable fan-out degrades visibly to one native Claude bridge.
- `--codex` / `--no-codex` / `--no-opus` / `--no-agy`, and `--codex-only` (= `--codex --no-opus --no-agy`).
- `/deep-review-loop --ultracode --codex`: ultracode once (round 1) + codex every round.
- No-flag behavior is 100% unchanged.
- `/deep-review-loop` convergence is deterministic: each round's findings are compared with `compare-rounds` (identity matching, not a natural-language repeat judgment), and a stalled round stops with the last trusted verdict.
- The loop passes a `--prior-rounds-file` advisory context between rounds explicitly (never by file existence) so reviewers can re-verify prior findings and rejected items.
- The final loop summary reports a `rounds_saved` metric.
- `--session-doc` (loop-only, opt-in) keeps one consolidated session document keyed by the loop id — current verdict, per-round history, open-vs-resolved rollup, and a final post-stop summary — while per-round reports and their fail-closed accounting stay untouched.
- `--dry-run` / `--explain-routing` (review-only, opt-in) run the deterministic artifact classifier and stop before any reviewer; semantic classification and model/effort routing arrive in a later phase.

## Review pipeline

deep-review runs a 4-stage pipeline on every invocation, with an optional Stage 5 for responding to findings:

```
Stage 1: Collect      — Detect environment, gather diff
Stage 2: Contract     — Load Sprint Contract if present
Stage 3: Deep Review  — Dispatch the available independent reviewer roles
Stage 4: Verdict      — Synthesize findings, emit APPROVE / CONCERN / REQUEST_CHANGES
Stage 5: Respond      — Evidence-based response to findings (via --respond)
```

### Stage 1: Collect

Environment detection determines the git state and collects the matching diff:

- `non-git` — ask the user which files to review
- `initial` (zero commits) — review all files against the empty tree
- `clean` — `git diff {review_base}..HEAD`
- `staged` — `git diff --cached`
- `unstaged` — `git diff`
- `mixed` — `git diff HEAD`
- `untracked-only` — read untracked files directly

Excluded from the diff: binaries, `vendor/`, `node_modules/`, `dist/`, `build/`, `.next/`, `target/`, `.venv/`, `__pycache__/`, `.pytest_cache/`, `.git/`, `*.min.js`, `*.generated.*`, `*.lock`, `.DS_Store`.

### Stage 2: Contract check

- `--contract SLICE-NNN` — load only `.deep-review/contracts/SLICE-NNN.yaml` (must be `status: active`)
- `--contract` — load all `status: active` contracts
- No flag — active contracts in `.deep-review/contracts/` load automatically; archived contracts are excluded
- Malformed YAML — the contract is skipped with a warning

Each criterion is verified against the actual code changes.

### Stage 3: Deep Review

Claude Code uses an independent named `code-reviewer` agent when that capability is available and otherwise uses the native Node Claude bridge. Codex uses a generic subagent for its standard `codex-review` role and may use the Node Claude bridge for a separate Claude-family role when the Claude CLI is installed. Before dispatch, you are told which reviewers will run. Every reviewer receives only the shared payload — never the originating session context — and evaluates 6 criteria:

| # | Criterion | Checks |
|---|---|---|
| 1 | Correctness | Logic bugs, edge cases, error handling |
| 2 | Architecture fit | `rules.yaml` violations, layer boundaries, dependency direction |
| 3 | Entropy | Duplicate code, pattern drift, ad-hoc helpers |
| 4 | Test coverage | Coverage relative to changes, missing scenarios |
| 5 | Readability | Will the next agent understand this on first read? |
| 6 | Security | Input validation, authz bypass, injection (incl. prompt injection), secret exposure, unsafe ops |

The shared reviewer payload — used by the Opus reviewer, ultracode shards, and agy — includes:

- **`change_files` manifest** — a NUL-safe, capped cross-file manifest (rename/copy detection, dirty-state untracked union) so reviewers see the whole changeset, not just one diff; the diff itself is ordered last for instruction-attention. It honors the same Stage 1 exclusions as the diff.
- **FP-suppression doctrine** — a false-positive-suppression doctrine plus a conservative-balance counterweight, single-sourced from `review-criteria.md` and injected into the Opus prompt, ultracode shards, and the agy payload. The standard `codex review` and Codex adversarial passes are intentionally excluded, preserving their aggression.

### Stage 4: Verdict

| Finding | Verdict |
|---|---|
| Any 🔴 Critical | `REQUEST_CHANGES` |
| 🟡 Warnings, all reviewers agree | `REQUEST_CHANGES` |
| 🟡 Warnings, split opinion | `CONCERN` |
| All pass | `APPROVE` |

The report is saved to `.deep-review/reports/{YYYY-MM-DD}-{HHmmss}-review.md`.

### Codex auto-exposure protocol

When an eligible companion process needs gitignored review inputs, `/deep-review` detects those paths, requests approval, and temporarily exposes only the approved set through the persisted Node mutation protocol. The protocol owns an opaque cross-process token, restores the exact index state, and auto-recovers interrupted operations. Native Codex generic subagents read allowed paths directly and never trigger index mutation merely because Codex is the host. Sensitive patterns (`.env*`, credentials, SSH keys, GCP service accounts, `.pgpass`, `.netrc`, `wrangler.toml`, JWT, and more) are scanned case-insensitively and fail closed.

## Cross-model verification

When multiple reviewer roles are available, review runs in parallel and synthesizes trusted results by confidence level:

```
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
     Claude Opus           codex:review      codex:adversarial
    (Independent           (Standard         (Adversarial
     subagent)              review)           review)
              │                  │                  │
              └──────────────────┼──────────────────┘
                                 ▼
                    ┌────────────────────────┐
                    │   Synthesis by         │
                    │   Confidence Level     │
                    │                        │
                    │  All agree  → 🔴 High  │
                    │  2/3 agree  → 🟡 Med   │
                    │  1/3 only   → ℹ️ Note  │
                    │  All pass   → 🟢       │
                    └────────────────────────┘
```

The `agy` (Google Antigravity) CLI joins as a 4th, cross-vendor-family reviewer when detected. If no Codex reviewer role is available, deep-review notifies once and continues with the available roles. If a reviewer fails (auth error, timeout), it falls back gracefully and marks that reviewer as "not performed."

For `staged`, `unstaged`, and `mixed` states, deep-review offers to create a WIP commit so cross-model verification can run against a real commit base. The prompt previews the file list, warns about sensitive patterns, and never uses `git add -A`; undo with `git reset --soft HEAD~1`. Shallow clones are detected with a `git fetch --unshallow` recommendation.

## Receiving review (Stage 5)

When Stage 4 returns `REQUEST_CHANGES`, deep-review offers an evidence-based response (`/deep-review --respond`) or manual handling. The `--respond` flag activates a 6-phase protocol:

| Phase | Action |
|---|---|
| READ | Read all feedback items without reacting |
| UNDERSTAND | Restate each requirement technically |
| VERIFY | Cross-check against the codebase (files, grep, tests, blame) |
| EVALUATE | Judge by source trust level — accept / reject / defer |
| RESPOND | Accept with a fix or reject with evidence |
| IMPLEMENT | Apply fixes by severity priority, committed per severity group |

Each source has a default trust level that sets the verification bar:

| Source | Default trust |
|---|---|
| Human (user) | High |
| deep-review Opus | Medium |
| Codex review | Medium |
| Codex adversarial | Low |
| PR comment (external) | Low |

`/deep-review --respond --source=pr` collects GitHub PR comments via `gh api` and applies the same protocol — inline comments get threaded replies, general comments get issue-level replies. Each session produces a report at `.deep-review/responses/{YYYY-MM-DD}-{HHmmss}-response.md` documenting every decision with evidence.

## Sprint Contract

A Sprint Contract defines the success criteria for a feature slice; deep-review verifies each criterion against the actual code, not the intent. Contracts live in `.deep-review/contracts/SLICE-NNN.yaml`:

```yaml
slice: SLICE-001
title: "JWT Authentication"
status: active
criteria:
  - id: C1
    description: "Token expiry is validated on every protected route"
    verification: auto       # auto | manual | mixed
    status: null             # filled by Evaluator: PASS | FAIL | PARTIAL | SKIP
    evidence: null           # filled by Evaluator
```

- `verification: auto` — the Evaluator reads the code and determines pass/fail.
- `verification: manual` — skipped automatically, flagged as "requires manual confirmation."
- `verification: mixed` — auto-verifiable parts are checked; the rest are skipped.

## Configuration

deep-review reads several files under `.deep-review/`:

- **`rules.yaml`** (inferential) — project-specific review rules generated by `/deep-review init`; the LLM reads and applies them. Without it, generic best-practice criteria are used.
- **`fitness.json`** (computational) — architecture fitness rules created and verified by the deep-work Health Engine; when present, they are injected into the reviewer prompt for architecture-intent-aware review.
- **`config.yaml`** — runtime state (review model, Codex/agy notification flags, fingerprint mode), auto-created on first run and updated one field at a time so manual edits survive.
- **`recurring-findings.json`** — after each review, recurring patterns are classified into a 7-category taxonomy (`error-handling`, `naming-convention`, `type-safety`, `test-coverage`, `security`, `performance`, `architecture`) and emitted as an M3 cross-plugin envelope, consumed by deep-evolve to steer experiment direction.

**Team sharing**: `rules.yaml`, `contracts/`, and `journeys/` encode project knowledge and should be committed; `config.yaml`, `reports/`, `responses/`, `entropy-log.jsonl`, and `recurring-findings.json` are per-machine runtime state. `/deep-review init` configures your `.gitignore` to enforce this split.

`review_model` accepts any non-empty installed Claude model alias and forwards it unchanged; for example, `review_model: fable`.

## Links

- [Changelog](./CHANGELOG.md)
- [claude-deep-suite](https://github.com/Sungmin-Cho/claude-deep-suite) — the marketplace and sibling plugins
- [Contributing](./CONTRIBUTING.md) · [Security policy](./SECURITY.md)

## License

[MIT](./LICENSE)
