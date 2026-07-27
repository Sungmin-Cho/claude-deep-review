# deep-review - Claude Code Project Guide

Independent Evaluator for AI coding agents. This repository ships the Claude
Code command adapter, cross-runtime skills, native Node runtime, reviewer
definitions, and compatibility oracles.

Read the current version with:

```bash
node -p "require('./package.json').version"
```

> 📄 Documentation in this repo follows `docs/DOCS_RULE.md` (local maintainer
> guide — single-source-of-truth rules for README, CHANGELOG, and agent guides).

## Runtime surfaces

- Claude adapter: `commands/deep-review.md`
- Public skills: `skills/deep-review/SKILL.md` and
  `skills/deep-review-loop/SKILL.md`
- Pipeline references: `skills/deep-review-workflow/references/`
- Response references: `skills/receiving-review/references/`
- Native runtime: `hooks/scripts/*.mjs` and `hooks/scripts/lib/*.mjs`
- Agent definitions: `agents/code-reviewer.md` and
  `agents/phase6-implementer.md`

Runtime state under `.deep-review/` is not product source and must not be
committed unless explicitly requested as an artifact.

## Release invariants

- Node 22 is the supported runtime on macOS, Linux, and native Windows 11.
- Supported review/respond/loop paths use Node or direct host tools, never
  Git Bash or shell-only helpers.
- Legacy `hooks/scripts/test/test-*.sh` files are Unix parity oracles only.
- Claude and Codex manifests plus `package.json` always share one version.
- `.codex-plugin/plugin.json` uses default hook discovery and contains no
  `hooks` or `mcpServers` key.
- Public routing stays capability-based; host markers are diagnostic only.
- Preserve fail-closed reviewer counting, fingerprint exclusions, persisted
  mutation ownership, and Phase 6 snapshot/verify/commit gates.
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
