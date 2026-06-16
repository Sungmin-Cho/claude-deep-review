**English** | [한국어](./README.ko.md)

# deep-review

![version](https://img.shields.io/github/package-json/v/Sungmin-Cho/claude-deep-review?label=version)
![license](https://img.shields.io/github/license/Sungmin-Cho/claude-deep-review)
[![part of deep-suite](https://img.shields.io/badge/part%20of-deep--suite-5b8def)](https://github.com/Sungmin-Cho/claude-deep-suite)

An independent Evaluator plugin for AI coding agents — cross-model code review with Codex integration and Sprint Contract support.

AI coding agents have a structural blind spot: they review their own work. The agent that wrote the code also judges it, so self-approval bias is built in. deep-review spawns a **separate Opus subagent** that sees only the diff — not the reasoning, intentions, or assumptions behind the code — for a structurally independent evaluation. When [Codex](https://github.com/openai/codex) (and optionally the `agy` CLI) is installed, the review escalates to parallel cross-model verification and synthesizes findings by confidence level.

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

## Commands

| Command | Description |
|---|---|
| `/deep-review` | Review current changes with an independent Opus subagent (cross-model when Codex/agy are present) |
| `/deep-review --ultracode [--codex]` | Multi-agent Claude fan-out (hybrid: Workflow tool when available, else parallel `code-reviewer` agents), collapsed into one "Claude(ultracode)" voice + optional Codex 2-way |
| `/deep-review --codex-only` | Disable internal Claude reviewer, run Codex 2-way only (pairs with an external `--ultracode` session for role separation) |
| `/deep-review --contract [SLICE-NNN]` | Sprint Contract-based structural verification |
| `/deep-review --entropy` | Entropy scan (duplicates, pattern drift, naming mismatches) |
| `/deep-review --respond [REPORT_PATH]` | Respond to review findings with the evidence-based protocol |
| `/deep-review --respond --source=pr` | Respond to GitHub PR review comments |
| `/deep-review-loop [--max=N]` | Auto-iterate review ↔ respond until convergence (also a `user-invocable` skill — `Skill({ skill: "deep-review:deep-review-loop" })` for Codex CLI / SDK consumers) |
| `/deep-review-loop --ultracode --codex` | ultracode once (round 1) + codex every round integrated loop |
| `/deep-review init` | Initialize per-project review rules interactively |

**Composable reviewer flags** (v1.10.0):

- `--ultracode` — Claude-side review as a multi-agent fan-out (hybrid: Workflow tool when available, else parallel `code-reviewer` agents), collapsed into one "Claude(ultracode)" voice.
- `--codex` / `--no-codex` / `--no-opus` / `--no-agy`, and `--codex-only` (= `--codex --no-opus --no-agy`).
- `/deep-review-loop --ultracode --codex`: ultracode once (round 1) + codex every round.
- No-flag behavior is 100% unchanged.

## Review pipeline

deep-review runs a 4-stage pipeline on every invocation, with an optional Stage 5 for responding to findings:

```
Stage 1: Collect      — Detect environment, gather diff
Stage 2: Contract     — Load Sprint Contract if present
Stage 3: Deep Review  — Spawn Opus subagent in background (+ Codex / agy if available)
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

Excluded from the diff: binaries, `vendor/`, `node_modules/`, `*.min.js`, `*.generated.*`, `*.lock`.

### Stage 2: Contract check

- `--contract SLICE-NNN` — load only `.deep-review/contracts/SLICE-NNN.yaml` (must be `status: active`)
- `--contract` — load all `status: active` contracts
- No flag — active contracts in `.deep-review/contracts/` load automatically; archived contracts are excluded
- Malformed YAML — the contract is skipped with a warning

Each criterion is verified against the actual code changes.

### Stage 3: Deep Review

An independent `code-reviewer` agent is spawned with `model: opus` and `run_in_background: true`. In Codex / non-Claude runtimes the same reviewer is invoked through `claude -p --agent code-reviewer`. Before spawning, you are told which reviewers will run (Opus-only or cross-model). The agent receives only the diff, rules, and contract — never the originating session context — and evaluates 6 criteria:

| # | Criterion | Checks |
|---|---|---|
| 1 | Correctness | Logic bugs, edge cases, error handling |
| 2 | Architecture fit | `rules.yaml` violations, layer boundaries, dependency direction |
| 3 | Entropy | Duplicate code, pattern drift, ad-hoc helpers |
| 4 | Test coverage | Coverage relative to changes, missing scenarios |
| 5 | Readability | Will the next agent understand this on first read? |
| 6 | Security | Input validation, authz bypass, injection (incl. prompt injection), secret exposure, unsafe ops |

### Stage 4: Verdict

| Finding | Verdict |
|---|---|
| Any 🔴 Critical | `REQUEST_CHANGES` |
| 🟡 Warnings, all reviewers agree | `REQUEST_CHANGES` |
| 🟡 Warnings, split opinion | `CONCERN` |
| All pass | `APPROVE` |

The report is saved to `.deep-review/reports/{YYYY-MM-DD}-{HHmmss}-review.md`.

### Codex auto-exposure protocol

In a git repo with the Codex plugin installed, `/deep-review` detects gitignored files you have been editing this session — typically specs, research notes, or planning docs — and offers to temporarily expose them to Codex for cross-model review. It presents the exact `git` commands in a single prompt, acquires an atomic `mkdir` lock, runs the review against `--scope working-tree`, then restores state (preserving anything you staged for real during the review). Sessions that crash mid-mutation are auto-recovered on the next invocation. Sensitive patterns (`.env*`, credentials, SSH keys, GCP service accounts, `.pgpass`, `.netrc`, `wrangler.toml`, JWT, and more) are scanned case-insensitively; an all-sensitive set is auto-skipped without prompting.

## Cross-model verification

When Codex is installed and git commits are available, review runs in parallel and synthesizes by confidence level:

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

The `agy` (Google Antigravity) CLI joins as a 4th, cross-vendor-family reviewer when detected. If Codex is not installed, deep-review notifies once and proceeds with Opus solo. If a reviewer fails (auth error, timeout), it falls back gracefully and marks that reviewer as "not performed."

For `staged`, `unstaged`, and `mixed` states, deep-review offers to create a WIP commit so cross-model verification can run against a real commit base. The prompt previews the file list, warns about sensitive patterns, and never uses `git add -A`; undo with `git reset --soft HEAD~1`. Shallow clones are detected with a `git fetch --unshallow` recommendation.

## Receiving review (Stage 5)

When Stage 4 returns `REQUEST_CHANGES`, deep-review offers an evidence-based response (`/deep-review --respond`), delegation to `codex:rescue` (when Codex is installed), or manual handling. The `--respond` flag activates a 6-phase protocol:

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

## Links

- [Changelog](./CHANGELOG.md)
- [claude-deep-suite](https://github.com/Sungmin-Cho/claude-deep-suite) — the marketplace and sibling plugins
- [Contributing](./CONTRIBUTING.md) · [Security policy](./SECURITY.md)

## License

[MIT](./LICENSE)
