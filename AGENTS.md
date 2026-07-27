# deep-review - Codex Project Guide

Independent Evaluator for AI coding agents. This repository exposes native
Codex skills alongside the Claude Code adapter and a shared zero-dependency
Node runtime.

Read the current version with:

```bash
node -p "require('./package.json').version"
```

> 📄 Documentation in this repo follows `docs/DOCS_RULE.md` (local maintainer
> guide — single-source-of-truth rules for README, CHANGELOG, and agent guides).

## Runtime surfaces

- Codex manifest: `.codex-plugin/plugin.json`
- Claude manifest: `.claude-plugin/plugin.json`
- Public skills: `skills/deep-review/SKILL.md` and
  `skills/deep-review-loop/SKILL.md`
- Claude adapter: `commands/deep-review.md`
- Shared runtime: `hooks/scripts/*.mjs` and `hooks/scripts/lib/*.mjs`
- Legacy Unix oracles: `hooks/scripts/test/test-*.sh`

Review output under `.deep-review/` is runtime state and should not be
committed unless explicitly requested.

## Release invariants

- Node 22 supports macOS, Linux, and native Windows 11 without Git Bash.
- Keep supported runtime references shell-free and capability-routed.
- Keep versions synchronized across both manifests and `package.json`.
- Never add official Codex `hooks` or `mcpServers` manifest keys.
- Preserve N_actual=0 fail-closed behavior, read-only fingerprints, mutation
  ownership, and Phase 6 verification before commit.
- Keep README and CHANGELOG pairs structurally bilingual and evergreen.

## Verification

```bash
npm test
npm run test:legacy
node --test tests/plugin-contract.test.js tests/skill-runtime-contract.test.js tests/native-release-smoke.test.js
# maintainer-local — skip if the validator is absent on this machine
python3 /Users/sungmin/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
git diff --check
```
