// Ranged citation `path:START-END` — and comma-separated multi-range spans like
// `path:1-2, 83-100` — are captured with only the FIRST range's START line
// (mirrors loop-state.mjs `firstLocationToken`). The trailing
// `(?:\s*,\s*\d+(?:-\d+)?)*` consumes any additional ranges inside the same
// backticks so they neither break the match nor mint phantom findings.
const BACKTICKED_LOCATION = /`([^`\r\n]+):(\d+)(?:-\d+)?(?:\s*,\s*\d+(?:-\d+)?)*`/gu;
const BARE_LOCATION = /(?:^|[\s(])((?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+):(\d+)(?=$|[\s,.)])/gu;
// Strips an already-captured backticked location (ranged and multi-range suffix
// included) so the bare pass never re-matches a quoted path's digits — or a
// trailing range's digits — as prose.
const QUOTED_LOCATION_STRIP = /`[^`\r\n]+:\d+(?:-\d+)?(?:\s*,\s*\d+(?:-\d+)?)*`/gu;

/**
 * A bare (non-backtick) `path:line` token is only a real location if the path
 * component looks like a path: it must contain a directory separator or end
 * in a filename-shaped extension. This rejects unquoted prose like
 * 'backoff at 3:30' (path='3') from registering as a phantom finding.
 */
function isPathLikeToken(pathText) {
  if (/[\\/]/u.test(pathText)) return true;
  return /\.[A-Za-z][A-Za-z0-9]*$/u.test(pathText);
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (value.includes('\0')) {
    throw new TypeError(`${label} must not contain NUL`);
  }
}

function stripDotSegments(pathText) {
  const segments = pathText.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  return segments.join('/');
}

/**
 * Normalize a report-extracted path into a repo-relative, slash-delimited
 * identity key. Mirrors loop-state.mjs `assertSamePath`'s win32-only
 * case-fold rule; canonicalization otherwise never resolves against the
 * filesystem (pure string handling).
 */
export function canonicalizeRepoPath(rawPath, { repoRoot, platform = process.platform } = {}) {
  assertNonEmptyString(rawPath, 'path');
  const isWin = platform === 'win32';
  let normalized = rawPath.replace(/\\/gu, '/');

  if (typeof repoRoot === 'string' && repoRoot.length > 0) {
    const rootNormalized = repoRoot.replace(/\\/gu, '/').replace(/\/+$/u, '');
    const compare = (value) => (isWin ? value.toLowerCase() : value);
    const rootCompare = compare(rootNormalized);
    const pathCompare = compare(normalized);
    if (rootCompare.length > 0 && (pathCompare === rootCompare || pathCompare.startsWith(`${rootCompare}/`))) {
      normalized = normalized.slice(rootNormalized.length).replace(/^\/+/u, '');
    }
  }

  normalized = stripDotSegments(normalized);
  if (isWin) normalized = normalized.toLowerCase();
  return normalized;
}

/**
 * Deterministic, boundedly-short slug for a finding's title text: used as a
 * tiebreaker (never a sole key) in matchFindings.
 */
export function titleSlug(text) {
  if (typeof text !== 'string') return '';
  const slug = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9ㄱ-ㆎ가-힣]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return slug.slice(0, 40);
}

function severityAt(lineText) {
  if (/^###\s+\u{1F534}\s+Critical/iu.test(lineText)) return 'critical';
  if (/^###\s+\u{1F7E1}\s+Warning/iu.test(lineText)) return 'warning';
  if (/^###\s+/u.test(lineText)) return '';
  return undefined;
}

/**
 * Extract `{severity, path, line, title_slug}` records from a canonical
 * review report's Critical/Warning sections. Reuses loop-state.mjs
 * `signatures()`'s backtick + bare file:line detection so identity stays
 * aligned with the existing (vestigial) findings_signature extraction.
 */
export function extractFindings(markdown, { repoRoot } = {}) {
  if (typeof markdown !== 'string') throw new TypeError('markdown must be a string');
  const findings = [];
  let severity = '';
  for (const lineText of markdown.split(/\r?\n/u)) {
    const nextSeverity = severityAt(lineText);
    if (nextSeverity !== undefined) {
      severity = nextSeverity;
      continue;
    }
    if (!severity) continue;

    const backticked = [...lineText.matchAll(BACKTICKED_LOCATION)];
    const withoutQuotedPaths = lineText.replace(QUOTED_LOCATION_STRIP, ' ');
    const bare = [...withoutQuotedPaths.matchAll(BARE_LOCATION)]
      .filter((match) => isPathLikeToken(match[1]));
    const matches = [...backticked, ...bare];
    if (matches.length === 0) continue;

    const titleText = lineText
      .replace(QUOTED_LOCATION_STRIP, ' ')
      .replace(BARE_LOCATION, ' ')
      .replace(/^\s*[-*]\s*/u, '')
      .trim();
    const slug = titleSlug(titleText);

    for (const match of matches) {
      findings.push({
        severity,
        path: canonicalizeRepoPath(match[1], { repoRoot }),
        line: Number(match[2]),
        title_slug: slug,
      });
    }
  }
  return findings;
}

/**
 * Deterministic, 1:1 greedy matcher between adjacent-round findings.
 * Candidates require identical severity+path and |line delta| <= tolerance;
 * an exact title_slug match outranks a closer line distance so an unrelated
 * finding at the same edited hunk is not mismatched. Unmatched entries are
 * conservatively classified resolved (previous-only) or added (current-only).
 */
export function matchFindings(previous = [], current = [], { tolerance = 6 } = {}) {
  if (!Array.isArray(previous) || !Array.isArray(current)) {
    throw new TypeError('previous and current must be arrays');
  }
  const candidates = [];
  for (let p = 0; p < previous.length; p += 1) {
    const prevFinding = previous[p];
    for (let c = 0; c < current.length; c += 1) {
      const currFinding = current[c];
      if (prevFinding.severity !== currFinding.severity) continue;
      if (prevFinding.path !== currFinding.path) continue;
      const distance = Math.abs(prevFinding.line - currFinding.line);
      if (distance > tolerance) continue;
      const slugMatch = Boolean(prevFinding.title_slug) && prevFinding.title_slug === currFinding.title_slug;
      candidates.push({ p, c, distance, slugMatch });
    }
  }

  candidates.sort((left, right) => {
    if (left.slugMatch !== right.slugMatch) return left.slugMatch ? -1 : 1;
    if (left.distance !== right.distance) return left.distance - right.distance;
    const leftPrev = previous[left.p];
    const rightPrev = previous[right.p];
    if (leftPrev.line !== rightPrev.line) return leftPrev.line - rightPrev.line;
    const leftCurr = current[left.c];
    const rightCurr = current[right.c];
    if (leftCurr.line !== rightCurr.line) return leftCurr.line - rightCurr.line;
    return 0;
  });

  const usedPrev = new Set();
  const usedCurr = new Set();
  const repeated = [];
  for (const candidate of candidates) {
    if (usedPrev.has(candidate.p) || usedCurr.has(candidate.c)) continue;
    usedPrev.add(candidate.p);
    usedCurr.add(candidate.c);
    repeated.push([previous[candidate.p], current[candidate.c]]);
  }

  const resolved = previous.filter((_finding, index) => !usedPrev.has(index));
  const added = current.filter((_finding, index) => !usedCurr.has(index));
  return { repeated, resolved, added };
}
