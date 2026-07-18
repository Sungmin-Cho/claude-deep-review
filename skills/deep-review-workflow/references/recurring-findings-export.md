# Recurring findings export — Stage 5.5

Run after a review report is written. Skip when fewer than two canonical
`*-review.md` reports exist.

## Taxonomy

Classify all Critical and Warning issues in one pass into exactly one of:

- `error-handling`
- `naming-convention`
- `type-safety`
- `test-coverage`
- `security`
- `performance`
- `architecture`

A category with at least three occurrences is recurring. Mixed severity takes
the highest severity. Write the classification through a direct host file tool
to a private payload file with this shape:

```json
{
  "updated_at": "RFC3339",
  "taxonomy_version": "1.0",
  "findings": [
    {
      "category": "error-handling",
      "severity": "critical",
      "occurrences": 3,
      "example_files": ["src/example.js:42"],
      "description": "concise recurring pattern",
      "source_reports": ["2026-07-13-100000-review.md"]
    }
  ]
}
```

## Node export

Resolve the absolute helper path from the runtime `plugin_root`, and invoke the
equivalent argv sequence:

```text
node wrap-recurring-findings-envelope.js --payload-file FILE --output FILE --discover-sources-from PROJECT_ROOT
```

`--discover-sources-from` performs deterministic Node filesystem discovery. It
selects the lexically newest canonical `.deep-work/<session>/session-receipt.json`
(with the legacy receipt filename accepted as fallback) and the newest twenty
`.deep-review/reports/*.md` files. The receipt appears first in provenance and
reports follow newest-first. Spaces, Unicode, and Windows paths remain argv
data; no host command language is involved.

The wrapper validates a deep-work envelope before chaining its `run_id` as
`parent_run_id`. A legacy or foreign receipt is retained as path-only
provenance. Generic report sources remain path-only unless they contain a
self-consistent envelope.

On success, remove the private payload through a direct host file tool. On any
wrapper failure, preserve the payload for retry, return a visible nonzero
result, and do not replace the previous canonical recurring artifact.

Optional validation uses this direct Node argv call with the emitted path:

```text
node {plugin_root}/scripts/validate-envelope-emit.js OUTPUT_FILE
```
