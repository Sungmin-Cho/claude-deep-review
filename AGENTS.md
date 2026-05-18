# deep-review - Codex Project Guide

Independent Evaluator for AI coding agents. This repo keeps the Claude Code
plugin surface and exposes Codex-native plugin metadata and skill entrypoints.

Current version: 1.6.1.

## Runtime Surfaces

- Codex manifest: `.codex-plugin/plugin.json`
- Claude Code manifest: `.claude-plugin/plugin.json`
- User-invocable skills: `skills/deep-review-*/` and `skills/receiving-review/`
- Legacy command reference: `commands/deep-review.md`
- Hooks: `hooks/hooks.json` and `hooks/scripts/`
- Agents: `agents/`

Review output under `.deep-review/` is runtime state and should not be committed
unless explicitly requested as an artifact.

## Verification

```bash
node -e "JSON.parse(require('fs').readFileSync('.codex-plugin/plugin.json','utf8'))"
npm test
```

After a release, update both suite marketplace manifests in
`/Users/sungmin/Dev/claude-plugins/deep-suite/`.
