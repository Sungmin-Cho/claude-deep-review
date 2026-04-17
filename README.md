**English** | [한국어](./README.ko.md)

# Deep Review Plugin

An independent Evaluator plugin for AI coding agents — cross-model code review with Codex integration and Sprint Contract support.

## The Problem

AI coding agents have a fundamental blind spot: they review their own work.

- The agent that wrote the code also judges it — self-approval bias is structural
- Opus writes 500 lines and then "reviews" them in the same context window
- Critical bugs, architectural drift, and entropy accumulate undetected
- Without separation between Generator and Evaluator, "review" is just narration

Generator-Evaluator separation is not optional. It's the only way to get an honest second opinion.

## The Solution

Deep Review spawns a **separate Opus subagent** with no knowledge of the original session context. It sees only the diff — not the reasoning, intentions, or assumptions behind the code. This is a structurally independent evaluation.

When [Codex](https://github.com/openai/codex) is installed, the review escalates to **3-way parallel verification**: Claude Opus + codex:review + codex:adversarial-review. Findings are synthesized by confidence level.

### Role in Harness Engineering

deep-review is the **independent evaluator** in the [Deep Suite](https://github.com/Sungmin-Cho/claude-deep-suite) ecosystem, implementing the Generator-Evaluator separation from the [Harness Engineering](https://martinfowler.com/articles/harness-engineering.html) framework.

In the 2×2 matrix:

- **Inferential Sensor**: Independent Opus subagent review with zero Generator context — the primary quality gate for semantic issues that computational sensors cannot catch
- **3-Way Cross-Model Verification**: Opus + Codex standard + Codex adversarial — exceeds the framework's "LLM-as-judge" concept
- **Fitness-Aware Review**: Consumes `fitness.json` rules and `health_report` from [deep-work](https://github.com/Sungmin-Cho/claude-deep-work) for architecture-intent-aware evaluation
- **Sprint Contract Verification**: Structured success criteria checking

## Key Commands

| Command | Description |
|---------|-------------|
| `/deep-review` | Review current changes with an independent Opus subagent |
| `/deep-review --contract` | Sprint Contract-based structural verification |
| `/deep-review --entropy` | Entropy scan (duplicates, pattern drift, naming mismatches) |
| `/deep-review --respond` | Respond to review findings with evidence-based protocol |
| `/deep-review --respond --source=pr` | Respond to GitHub PR review comments |
| `/deep-review init` | Initialize per-project review rules interactively |

## Review Pipeline

Deep Review runs a 4-stage pipeline on every invocation, with an optional Stage 5 for responding to findings:

```
Stage 1: Collect      — Detect environment, gather diff
Stage 2: Contract     — Load Sprint Contract if present
Stage 3: Deep Review  — Spawn Opus subagent in background (+ Codex if available)
Stage 4: Verdict      — Synthesize findings, emit APPROVE / CONCERN / REQUEST_CHANGES
Stage 5: Respond      — Evidence-based response to findings (via --respond)
```

### Stage 1: Collect

Environment detection script determines the git state and collects the appropriate diff:

- `non-git` — ask user which files to review
- `initial` (zero commits) — review all files against empty tree
- `clean` — `git diff {review_base}..HEAD`
- `staged` — `git diff --cached`
- `unstaged` — `git diff`
- `mixed` — `git diff HEAD`
- `untracked-only` — `git ls-files --others --exclude-standard`

Excluded from diff: binaries, `vendor/`, `node_modules/`, `*.min.js`, `*.generated.*`, `*.lock`

### Stage 2: Contract Check

`--contract` flag behavior:
- `--contract SLICE-NNN`: Load only `.deep-review/contracts/SLICE-NNN.yaml` (must be `status: active`)
- `--contract`: Load all `status: active` contracts in `.deep-review/contracts/`
- No flag: If active contracts exist in `.deep-review/contracts/`, they are loaded automatically
- `status: archived` contracts are excluded from auto-loading; if explicitly specified, a warning is shown
- YAML parse errors: skip the contract and emit a warning

Each criterion is verified against the actual code changes.

### Stage 3: Deep Review

An independent `code-reviewer` agent is spawned via the Agent tool with `model: opus` and `run_in_background: true`. Before spawning, the user is notified which reviewers will run (Opus-only or 3-way). It receives only the diff, rules, and contract — never the originating session context.

The agent evaluates 5 criteria:

| # | Criterion | Checks |
|---|-----------|--------|
| 1 | Correctness | Logic bugs, edge cases, error handling |
| 2 | Architecture fit | rules.yaml violations, layer boundaries, dependency direction |
| 3 | Entropy | Duplicate code, pattern drift, ad-hoc helpers |
| 4 | Test coverage | Coverage relative to changes, missing scenarios |
| 5 | Readability | Will the next agent understand this on first read? |

### Stage 4: Verdict

| Finding | Verdict |
|---------|---------|
| Any 🔴 Critical | `REQUEST_CHANGES` |
| 🟡 Warnings, all reviewers agree | `REQUEST_CHANGES` |
| 🟡 Warnings, split opinion | `CONCERN` |
| All pass | `APPROVE` |

Report is saved to `.deep-review/reports/{YYYY-MM-DD}-{HHmmss}-review.md` (timestamp prevents same-day overwrite).

## Receiving Review (Stage 5)

When Stage 4 returns `REQUEST_CHANGES`, Deep Review offers three options:

1. **Evidence-based response** (`/deep-review --respond`) — recommended
2. **Delegate to codex:rescue** — when Codex is installed
3. **Handle manually**

### 6-Phase Response Protocol

The `--respond` flag activates a structured response workflow:

| Phase | Action | Output |
|-------|--------|--------|
| READ | Read all feedback items without reacting | Item list with severity and source |
| UNDERSTAND | Restate each requirement technically | Restated requirements (no gratitude expressions) |
| VERIFY | Cross-check against codebase | Evidence object (files, grep, tests, blame) |
| EVALUATE | Judge by source trust level | Accept/reject/defer decision per item |
| RESPOND | Accept with fix or reject with evidence | Code changes or documented rejection |
| IMPLEMENT | Apply fixes by severity priority | Tested changes, committed by severity group |

### Source Trust Matrix

| Source | Default Trust | Verification Level |
|--------|--------------|-------------------|
| Human (user) | High | Implement after understanding, ask only if scope is unclear |
| deep-review Opus | Medium | Codebase cross-verification required |
| Codex review | Medium | Codebase cross-verification required |
| Codex adversarial | Low | Thorough code-evidence verification required |
| PR comment (external) | Low | 5-point external reviewer checklist applied |

### PR Comment Response (`--source=pr`)

`/deep-review --respond --source=pr` collects GitHub PR comments via `gh api` and applies the same 6-phase protocol. Inline comments receive threaded replies; general comments receive issue-level replies.

### Response Report

Each response session produces a structured report at `.deep-review/responses/{timestamp}-response.md` documenting every accept/reject/defer decision with evidence.

## Cross-Model Verification

When Codex is installed and git commits are available, review runs in 3-way parallel:

```
                    ┌─────────────────────────┐
                    │     Deep Review Start    │
                    └────────────┬────────────┘
                                 │
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

If Codex is not installed, Deep Review notifies once (stored in `config.yaml`) and proceeds with Claude Opus solo. If Codex is installed but fails (auth error, timeout), it falls back to Claude Opus solo and marks Codex as "not performed."

## Environment Adaptation

Deep Review works in any environment. Review strategy adjusts automatically:

| State | Condition | Review strategy |
|-------|-----------|-----------------|
| `non-git` | No git repo | Ask user for file list → full content review |
| `initial` | Git repo, 0 commits | All files against empty tree |
| `clean` | No pending changes | `git diff {base}..HEAD` |
| `staged` | Staged changes only | `git diff --cached` |
| `unstaged` | Unstaged changes only | `git diff` |
| `mixed` | Both staged + unstaged | `git diff HEAD` |
| `untracked-only` | New files, not staged | Read untracked files directly |

For `staged`, `unstaged`, and `mixed` states, Deep Review offers to create a WIP commit so Codex cross-verification can run against a real commit base.

Shallow clones (`git clone --depth`) are detected; a `git fetch --unshallow` recommendation is shown and HEAD~1 is used as fallback base.

## Sprint Contract

A Sprint Contract defines the success criteria for a feature slice. Deep Review verifies each criterion against the actual code — not the intent.

Contracts live in `.deep-review/contracts/SLICE-NNN.yaml`:

```yaml
slice: SLICE-001
title: "JWT Authentication"
source_plan: "plan.md#slice-001"
created_at: "2026-04-08T10:00:00Z"
status: active
criteria:
  - id: C1
    description: "Token expiry is validated on every protected route"
    verification: auto       # auto | manual | mixed
    prerequisites: []
    status: null             # filled by Evaluator: PASS | FAIL | PARTIAL | SKIP
    evidence: null           # filled by Evaluator
  - id: C2
    description: "Refresh flow tested under concurrent requests"
    verification: manual     # cannot be verified from code alone
    status: null
    evidence: null
```

`verification: auto` — Evaluator reads the code and determines pass/fail.
`verification: manual` — Skipped automatically, flagged as "requires manual confirmation."
`verification: mixed` — Auto-verifiable parts are checked; the rest are skipped.

Run `/deep-review --contract SLICE-NNN` to verify a specific slice, or `/deep-review --contract` to verify all active contracts. If active contracts exist in `.deep-review/contracts/`, they are automatically loaded without the flag. Archived contracts are excluded from auto-loading.

## Configuration

### `.deep-review/rules.yaml` (Inferential)

Project-specific review rules, generated interactively by `/deep-review init`. These are **inferential** rules — the LLM reads and applies them during review:

```yaml
architecture:
  layers: [api, service, repository]
  direction: top-down
  cross_cutting: [logger, config]

style:
  max_file_lines: 300
  naming: camelCase
  logging: structured

entropy:
  prefer_shared_utils: true
  max_similar_blocks: 3
  validate_at_boundaries: true
```

If `rules.yaml` does not exist, Deep Review uses generic best-practice criteria.

### `.deep-review/fitness.json` (Computational)

Architecture fitness rules that are **computationally verified** by the deep-work Health Engine. When present, Deep Review injects these rules into the review agent's prompt for architecture-intent-aware review.

```json
{
  "version": 1,
  "rules": [
    { "id": "no-circular-deps", "type": "dependency", "check": "circular", "severity": "required" },
    { "id": "max-file-lines", "type": "file-metric", "check": "line-count", "max": 500, "severity": "advisory" }
  ]
}
```

- **Created by**: deep-work Phase 1 Research (auto-generated with user approval)
- **Verified by**: deep-work Health Engine (code, not LLM)
- **Consumed by**: Deep Review Stage 3 (architecture intent context for LLM review)
- Rule types: `dependency`, `file-metric`, `forbidden-pattern`, `structure`
- If not present, review proceeds normally with `rules.yaml` only

### Receipt Health Report Integration

When deep-work's session receipt contains a `health_report` field, Deep Review uses it as additional context:

- **Discovery**: Searches `.deep-work/sessions/` for the most recent receipt
- **Staleness check**: Compares `health_report.scan_commit` against current `git rev-parse HEAD`
- **If fresh**: Drift issues and fitness violations are added to the review context
- **If stale or missing**: Skipped silently (not an error)

### `.deep-review/config.yaml`

Runtime state, auto-created on first run:

```yaml
review_model: opus       # opus | sonnet
codex_notified: false    # whether the Codex install hint has been shown
last_review: null        # timestamp of last review (ISO8601)
app_qa:                  # reserved for future App QA mode (v1.1 placeholder)
  last_command: null
  last_url: null
```

**Sharing policy (team usage)**:

- **Per-machine (do not commit)**: `config.yaml`, `reports/`, `responses/`, `entropy-log.jsonl`, `recurring-findings.json` — these represent session output or local runtime state and vary by machine.
- **Shared via git (tracked)**: `rules.yaml`, `contracts/`, `journeys/` — these encode project knowledge that should be synchronized across the team.
- `/deep-review init` updates your `.gitignore` to enforce this split automatically.

Updates to `config.yaml` are performed via the `Edit` tool on a single line at a time. This preserves any fields a user has modified manually (e.g., `review_model: sonnet`) and keeps unknown/reserved fields intact.

### Entropy Scan (`--entropy`)

Running `/deep-review --entropy` triggers a full-project entropy scan:

- Duplicate code blocks across files
- New helper functions that duplicate existing utilities
- Naming convention mismatches
- Results appended to `.deep-review/entropy-log.jsonl`

### Recurring Findings Export (v1.2)

After each review, automatically extracts recurring patterns and records them in `recurring-findings.json`.

**Taxonomy (7 categories):**
`error-handling`, `naming-convention`, `type-safety`, `test-coverage`, `security`, `performance`, `architecture`

**Behavior:**
- Runs when 2+ reports exist in `.deep-review/reports/`
- Classifies Critical/Warning items into taxonomy categories via LLM semantic classification
- Marks patterns as "recurring" when the same category appears 3+ times
- When severity is mixed within a category, adopts the highest severity

**Output:** `.deep-review/recurring-findings.json`
- Consumed by deep-evolve to steer experiment direction (prepare.py scenarios + program.md + strategy.yaml weights)

## Installation

```bash
claude plugin add deep-review
```

No additional configuration required. On first run, `.deep-review/` is created automatically with default `config.yaml`. Run `/deep-review init` to generate project-specific `rules.yaml`.

## License

MIT
