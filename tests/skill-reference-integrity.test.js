'use strict';

// Reference integrity for the instruction surfaces this plugin ships.
//
// Ported from deep-work's guard of the same name, with deep-goal's anchor model:
// the anchor here is a DOCUMENTATION PLACEHOLDER, not a shell variable — see the
// ANCHOR note below for why that difference removes a whole clause rather than
// merely renaming a token.
//
// Fence balance is checked because a `references/` split once truncated a fenced
// template mid-block: the entry kept the opening ``` and the first dozen template
// lines, the remainder moved behind a conditional pointer, and nothing failed. An
// odd fence count is the machine-detectable signature of that failure class.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ALWAYS_LOADED = ['AGENTS.md', 'CLAUDE.md'];

// The instruction surfaces. `commands/` is the Claude Code adapter and `agents/`
// are subagent briefs — both are read as instructions by an agent at runtime, so
// both are in scope alongside `skills/`. Restricting the scan to `skills/` would
// leave the adapter that resolves the plugin root unguarded, which is the one
// document the whole anchor contract depends on.
const SCANNED_DIRS = ['skills', 'agents', 'commands'];

function markdownFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.md')) out.push(p);
    }
  };
  for (const dir of SCANNED_DIRS) walk(path.join(ROOT, dir));
  // The always-loaded agent guides are instruction surfaces under the same rule.
  // `ALWAYS_LOADED` is asserted to be in the scan set by its own test, so dropping
  // it here fails loudly instead of silently shrinking coverage.
  for (const doc of ALWAYS_LOADED) {
    const p = path.join(ROOT, doc);
    if (fs.existsSync(p)) out.push(p);
  }
  return out;
}

// Every `.md` under the scanned directories — the documents an attacker would
// want to shadow. A bare Read(`review-execution.md`) names one of these with no
// basis at all, so it resolves against cwd, which is the target workspace.
const PLUGIN_DOCS = (() => {
  const names = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.md')) names.add(entry.name);
    }
  };
  for (const dir of SCANNED_DIRS) walk(path.join(ROOT, dir));
  return names;
})();

// Workspace-shadow guard.
//
// A bare `Read references/review-execution.md` or `node hooks/scripts/x.mjs`
// resolves against the *target workspace*, not the plugin. A repository under
// analysis can put a file at that path and have it read as instructions or run
// with the caller's Bash permissions.
//
// Parent-relative forms (`../deep-review-workflow/SKILL.md`) are just as
// shadowable. A markdown link resolves against the source file, but a runtime
// read has no such basis — it resolves against cwd. So this guard must NOT reuse
// the reference-integrity resolution below: integrity asks "does this file
// exist?" and may resolve relative to the source; the shadow guard asks "does
// this instruction name a trustworthy basis?", and only an explicit plugin-root
// anchor does.
//
// Two clauses, both required for every instruction form:
//   A. anchoring   — the path names the plugin root explicitly.
//   B. containment — the resolved path stays inside the plugin root.
// Clause B is not implied by A: `{plugin_root}/../workspace/evil.md` carries the
// anchor and still escapes.
//
// Scope: paths the plugin tells an agent to *open or run*. For `.js`/`.sh`/`.mjs`
// that is every mention — naming an executable is only useful for running it — so
// those are checked wherever they appear. A descriptive cross-reference to a `.md`
// in prose is not a load instruction, but deny-by-default below does not try to
// tell the two apart: any token resolving to a real plugin file must be anchored
// regardless of the sentence around it.
//
// ANCHOR. This plugin runs on both Claude Code and Codex. Its portable contract is
// `commands/deep-review.md` step 1: resolve the absolute plugin root once — generic
// `PLUGIN_ROOT`, then the Claude compatibility alias, then the installed command
// location supplied by the host — and write every path against that root.
// `{plugin_root}` is the placeholder for that derived root and is the repo's single
// anchor spelling.
//
// It is NOT a shell variable, and that is load-bearing rather than cosmetic. The
// reference implementation in deep-work carries a whole expansion clause —
// `nonExpandingAnchors`, `expansionState`, fenced-block detection, quoted-heredoc
// tracking — whose only question is "will the shell expand `${CLAUDE_PLUGIN_ROOT}`
// here?". There is no such variable in this repo, so every one of those rules would
// be code that cannot fire. What replaces them is stricter and much smaller: the
// shell spelling is banned outright (see the two anchor-spelling tests at the
// bottom), and a JS module load naming a plugin path is refused in every spelling,
// because no runtime substitutes a documentation placeholder.
//
// SEPARATORS. Windows is a supported host — this plugin runs on native Windows 11
// without Git Bash — so `hooks\scripts\public-route.mjs` names the same file as
// `hooks/scripts/public-route.mjs`. A matcher that knows only `/` lets the whole
// deny-by-default invariant be bypassed with one character.
//
// The fix is not to teach each matcher a second shape; that leaves the mixed form
// (`hooks\scripts/x.mjs`) open and re-opens on the next rule added. Instead every
// extracted token is normalised once, at tokenisation, so deny-by-default, the
// FORMS, bare-basename and containment all judge one canonical spelling without
// being taught anything. Runs of separators collapse, so an escaped
// `hooks\\scripts\\x.mjs` in a string literal normalises to the same path.
// Over-normalising is the safe direction here: a token only matters once it
// resolves to a real file in the plugin, and prose carrying a stray backslash
// resolves to nothing.
const SEP = String.raw`[\\/]`;
const normalizePath = (token) => token.replace(/[\\/]+/g, '/');

const PLUGIN_DIRS = 'skills|agents|commands|scripts|hooks|references|tests|docs';
// Two spellings of the same anchor: the literal text, and the regex-safe source.
// `{` and `}` are quantifier syntax, so the regex form must escape them — an
// unescaped `{plugin_root}` is only a literal by Annex B leniency and throws under
// a `u` flag.
const ANCHOR_LITERAL = '{plugin_root}';
const ANCHOR = String.raw`\{plugin_root\}`;
const ANCHORED_TOKEN = new RegExp(`^(?:${ANCHOR})/`);
const PATH_BODY = String.raw`[A-Za-z0-9._/\\{}|$<>-]+`;
const REL = String.raw`\.{1,2}${SEP}`;
const ANY_ROOT = String.raw`(?:(?:${ANCHOR})${SEP}|${REL}|(?:${PLUGIN_DIRS})${SEP})`;

// Each pattern captures the path token in group 1, so anchoring and containment
// are judged per token rather than per line — a line mixing an anchored and a bare
// path must still fail on the bare one.
const FORMS = [
  // 1. interpreter exec: `node X`, `bash X`, `sh X`, `python X`
  ['interpreter-exec', new RegExp(String.raw`\b(?:bash|sh|zsh|node|python3?)\s+["'\`]?(${ANY_ROOT}${PATH_BODY})`, 'g')],
  // 2. read verb: `Read X`, `Follow X`, `Read("X")`
  ['read-verb', new RegExp(String.raw`\b(?:Read|Follow|read|follow)\s*\(?\s*["'\`]?(${ANY_ROOT}${PATH_BODY}\.md)`, 'g')],
  // 3. direct exec / source: `source X`, `exec X`, `. X`
  ['direct-exec', new RegExp(String.raw`(?:\b(?:source|exec)\s+|^\s*\.\s+)["'\`]?(${ANY_ROOT}${PATH_BODY})`, 'gm')],
  // 4. executable path token anywhere — the form that hides a runtime helper named
  //    in prose. The trailing boundary matters: without it `.js` matches the prefix
  //    of `hooks.json` and the guard reports a file that does not exist.
  ['executable-token', new RegExp(String.raw`(?<![A-Za-z0-9._/\\{}<>$-])((?:${ANCHOR})${SEP}|${REL}|(?:${PLUGIN_DIRS})${SEP})([A-Za-z0-9._/\\-]*\.(?:mjs|cjs|js|sh)(?![A-Za-z0-9]))`, 'g')],
];

// DENY BY DEFAULT.
//
// Enumerating instruction syntaxes is the losing half of the problem — each round
// of the original review found a form outside the current allowlist: execution
// paths, parent-relative reads, traversal, unscanned root files, bare basenames, a
// JSON attachment. So the question is no longer "is this a known instruction
// syntax?" but "does this token resolve to a real file in the plugin?". Anything
// that does must be anchored, whatever the verb, extension or sentence around it —
// which covers `.json`, `.list`, `.yml`, extensionless scripts and assets that do
// not exist yet, without another form list. Anything that does not resolve is prose
// about the target project and passes.

// Repo-relative key, in the one spelling both sides of every PLUGIN_FILES
// comparison must use. `path.relative` returns the *host's* separator, so on
// Windows it hands back `hooks\scripts\envelope.js` while the token being looked up
// has already been normalised to `hooks/scripts/envelope.js` — the two never meet
// and the membership test misses every time. Normalising the token but not the key
// normalises one side of a comparison, which is not normalising at all.
// `relative` is injectable so the Windows spelling can be exercised from a POSIX CI
// run — path.win32.relative is the same implementation that host uses. It defaults
// to the host's and disables nothing, so it is a seam for emulation rather than a
// switch that can turn the rule off.
const repoKey = (from, to, relative = path.relative) => normalizePath(relative(from, to));

function trackedFiles() {
  const out = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

// THE SHIPPED SET, and which authority decides it.
//
// deep-work derives this from `package.json#files ∩ tracked`, because npm packs
// exactly what that field declares. **This repo's package.json has no `files`
// field**, so that authority does not exist here and copying the derivation would
// assert `[] `and index nothing. The authority used instead is git: a file the
// plugin ships is a file the plugin tracks.
//
// `tests/` is the one subtraction. It is maintainer-only — nothing under it is a
// runtime read an analysed workspace could shadow — and leaving it in would put
// this guard's own fixtures into the index it consults.
//
// Everything the previous `skip`-set approach got wrong falls out for free:
// `.deep-review/`, `docs/`, `.deep-loop/` and `.claude/` are gitignored, so they are
// absent from a clean clone and absent here, and what deny-by-default can see no
// longer differs between a maintainer's checkout and CI. Paths under those
// directories are handled by the NON_SHIPPED rules below, not by luck.
//
// `toKey` is the same kind of seam as repoKey's `relative`: it defaults to the
// production derivation and turns nothing off, but it lets a test build the index
// the way a Windows host spells it and then drive the real lookup against it. That
// is what makes both sides of the comparison behaviourally decidable from a POSIX
// runner — a source-text assertion can only pin the spelling of the call.
function buildPluginFiles({
  toKey = (p) => repoKey(ROOT, p),
  tracked = trackedFiles(),
} = {}) {
  const rel = new Set();
  for (const gitPath of tracked) {
    const key = normalizePath(gitPath);
    if (key === 'tests' || key.startsWith('tests/')) continue;
    rel.add(normalizePath(toKey(path.join(ROOT, gitPath))));
  }
  return rel;
}

const PLUGIN_FILES = buildPluginFiles();

// NON-SHIPPED PATHS.
//
// A path under a directory the plugin never ships is the *worst* case of the
// shadow class, not an exempt one: it cannot resolve inside an installed plugin at
// all, so the only place it can ever resolve is the analysed project. It is also
// the case deny-by-default structurally cannot see, because that rule asks "does
// this resolve in the plugin?" and the answer is permanently no.
//
// So each such path is listed here with the clauses that make it safe to read, and
// a test below asserts the document carries all of them.
//
// Pin the PROHIBITION, not the provenance. Matching "ships with nothing" alone is a
// fact about the file rather than an instruction about it — a caveat trimmed to
// that sentence deletes the whole protective clause while the test stays green.
// What keeps the path safe is the sentence telling a reader not to open it and why,
// so that is what is required here.
const NON_SHIPPED = new Map([
  ['docs/DOCS_RULE.md', [
    /ships with nothing/,
    /never try to open it at runtime/,
    /only place that path can resolve in an installed plugin is the project being analysed/,
  ]],
]);

// Blockquote markers and hard wraps must not decide whether a caveat counts, so the
// required clauses are matched against a flattened body.
function flatten(body) {
  return body.replace(/^[ \t]*>[ \t]?/gm, '').replace(/\s+/g, ' ');
}

// Single-segment root metadata named descriptively ("`package.json` declares
// engines", "the target project's `CLAUDE.md`"), never handed to a file tool.
// Multi-segment paths get no such pass.
//
// DERIVED, not enumerated. The reference implementations hand-list these, and a
// hand list is the shape this guard's history keeps punishing: it matches the tree
// on the day it is written. The exemption is only ever *needed* for a key with no
// separator — those are the only tokens deny-by-default can resolve as a bare
// basename — so the shipped set's own root-level entries are exactly the set, no
// more and no less. Known cost, stated: a future root-level file that an
// instruction really does tell an agent to open would be exempted here. That is the
// same cost the hand list carried, minus the drift.
const ROOT_METADATA = new Set([...PLUGIN_FILES].filter((k) => !k.includes('/')));

// Path-shaped tokens: multi-segment paths, plus dotted single segments.
// The `+` on the separator class is load-bearing. Without it a run of separators
// breaks the segment repetition, the whole-path alternative fails, and the
// tokeniser falls back to the bare-basename alternative — which resolves to
// nothing, so deny-by-default never sees the path. `.mjs` names survive that gap
// because the executable-token FORM's body class spans a run on its own; `.md` with
// no read verb has no such umbrella.
const PATH_TOKEN = /[A-Za-z0-9_.@${}<>-]+(?:[\\/]+[A-Za-z0-9_.@{}|*-]+)+|[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,6}\b/g;

// `files` is injectable for the same reason `toKey` is: the Windows key shape has
// to be pinnable in CI, not merely checked once by hand. `relative` is injectable
// alongside it because the `fromSource` normalisation is otherwise unpinnable: on
// POSIX `relative()` already returns slashes, so removing the normalisation is a
// no-op here and no mutation can see it. Only a win32 `relative` exercises it, and
// it has to be injected into the production call site — a copy of the logic in a
// test pins the test's arithmetic, not the guard's.
function resolvesInPlugin(token, sourceFile, files = PLUGIN_FILES, relative = path.relative) {
  const clean = normalizePath(token).replace(/^\.\//, '');
  if (files.has(clean)) return true;
  try {
    const fromSource = repoKey(ROOT, path.resolve(path.dirname(sourceFile), clean), relative);
    if (files.has(fromSource)) return true;
  } catch { /* unresolvable token — prose */ }
  return false;
}

// Scope, defined once. Yields the path tokens on a line that the invariant governs,
// with the documented exemptions applied. Both the classifier and the
// malicious-workspace fixture consume this, so they cannot test different rules.
function* scopedTokens(line) {
  PATH_TOKEN.lastIndex = 0;
  let m;
  while ((m = PATH_TOKEN.exec(line))) {
    // `<` and `>` are in the character class to admit angle-bracketed placeholders
    // (`<id>`, `<session>`) that appear mid-path. Without trimming them,
    // `<skills/…/x.md 첨부>` extracts with a leading `<`, fails to resolve, and the
    // token silently escapes the guard. The anchor here is brace-delimited, so —
    // unlike the deep-goal port this is adapted from — the trimming needs no
    // exception for it.
    let token = m[0];
    if (token.startsWith('<')) token = token.slice(1);
    if (token.endsWith('>')) token = token.slice(0, -1);
    // Normalise once, here, so every consumer of scopedTokens — the classifier, the
    // ROOT_METADATA lookup, and the malicious-workspace fixture alike — judges the
    // same string. Doing it any later means the basename exemption below sees
    // `SKILL.md` where the whole token was `skills\deep-review\SKILL.md`, which is
    // precisely the hole.
    token = normalizePath(token);
    if (!token.includes('/') && ROOT_METADATA.has(token)) continue;
    const before = line.slice(Math.max(0, m.index - 30), m.index);
    // Already inside an anchored path, written with either separator.
    if (/\{plugin_root\}["'\s]*[\\/]?$/.test(before)) continue;
    // Markdown link target `](x.md)` — rendered navigation between documents, not an
    // instruction handed to a file tool. Markdown does not interpolate, so these
    // must stay source-relative; the link-destination test below pins that they are
    // never anchored.
    if (/\]\($/.test(before)) continue;
    yield token;
  }
}

function denyByDefaultHits(line, sourceFile, root = ROOT) {
  const out = [];
  for (const token of scopedTokens(line)) {
    if (ANCHORED_TOKEN.test(token)) {
      // Clause B is enforced here, not deferred. A contained-looking path whose
      // component links out of the root is exactly the file an attacker wants
      // accepted, so both the lexical check and its symlink form run right here.
      // `every referenced plugin path resolves inside the root` is a second,
      // independent backstop: it resolves each anchored path for real.
      if (escapesRoot(token)) out.push({ form: 'resolves-in-plugin', token, why: 'escapes plugin root' });
      else if (escapesViaSymlink(token, root)) out.push({ form: 'resolves-in-plugin', token, why: 'escapes via symlink' });
      continue;
    }
    // Forward defence only: a non-shipped path never resolves in the plugin, so
    // this line is unreachable today. All of the actual protection is in the two
    // NON_SHIPPED tests below. It is kept so that adding such a path to the shipped
    // set later fails the caveat test rather than this rule silently.
    if (NON_SHIPPED.has(token)) continue;
    if (resolvesInPlugin(token, sourceFile)) {
      out.push({ form: 'resolves-in-plugin', token, why: 'unanchored' });
    }
  }
  return out;
}

// bare basename read: Read(`review-execution.md`). It resolves to no repo-relative
// path, so the rule above cannot see it — yet it is the weakest form of all,
// resolving straight against cwd. Only basenames that name a real plugin document
// are flagged, so ordinary prose is untouched.
const BARE_BASENAME = /\b(?:Read|Follow|read|follow)\s*\(?\s*["'`]([A-Za-z0-9][A-Za-z0-9._-]*\.md)(?:#[^`"']*)?["'`]/g;

// The executable twin. A read verb on a `.md` was covered; an interpreter on a
// runnable file was not, and that shape is strictly more dangerous: `node
// public-route.mjs` resolves against cwd — the analysed workspace — and running a
// planted file there is arbitrary code execution with the caller's permissions.
// Membership in the shipped set is still required, so prose that merely names a
// script is untouched; it is the interpreter that makes it an instruction.
const BARE_EXEC_BASENAME =
  /\b(?:node|python3?|deno|bun|bash|sh|zsh)\s+["'`]?([A-Za-z0-9][A-Za-z0-9._-]*\.(?:mjs|cjs|js|py|sh))["'`]?/g;

function bareBasenameHits(line) {
  const out = [];
  BARE_BASENAME.lastIndex = 0;
  let m;
  while ((m = BARE_BASENAME.exec(line))) {
    if (PLUGIN_DOCS.has(m[1])) out.push({ form: 'bare-basename', token: m[1], why: 'unanchored' });
  }
  const shippedBasenames = new Set([...PLUGIN_FILES].map((f) => f.split('/').pop()));
  BARE_EXEC_BASENAME.lastIndex = 0;
  while ((m = BARE_EXEC_BASENAME.exec(line))) {
    if (shippedBasenames.has(m[1])) {
      out.push({ form: 'bare-exec-basename', token: m[1], why: 'unanchored' });
    }
  }
  return out;
}

// JS module load — refused outright, in every spelling.
//
// The rule this enforces is "an instruction document does not embed a JS module
// load of a plugin file", not "anchor it properly". There is no safe textual form
// here, because `{plugin_root}` is a placeholder an *agent* substitutes while
// reading prose — no JS runtime expands it. `require("{plugin_root}/x.mjs")` is a
// bare package specifier, so Node searches the *workspace* node_modules and loading
// a planted module there is arbitrary code execution; the `${…}` spelling is the
// same defect, and its backtick form additionally interpolates a local variable
// rather than the environment. This plugin's documented runtime interface is the
// CLI, so any JS module load naming a plugin path inside an instruction document is
// a violation in every spelling.
const JS_MODULE_LOAD = /(?:\brequire\s*\(|\bimport\s*\(|\bimport\b[^;\n]*?\bfrom\s+)\s*["'`]([^"'`\n]+)["'`]/g;

function jsModuleLoadHits(line) {
  const out = [];
  JS_MODULE_LOAD.lastIndex = 0;
  let m;
  while ((m = JS_MODULE_LOAD.exec(line))) {
    const spec = m[1];
    if (/^node:/.test(spec)) continue;                       // built-in, names no path
    out.push({
      form: 'js-module-load',
      token: spec,
      why: 'JS specifier — no runtime substitutes the documentation anchor, so Node '
        + 'resolves it as a bare package under the workspace node_modules',
    });
  }
  return out;
}

const ROOT_SENTINEL = path.sep === '/' ? '/plugin-root' : 'C:\\plugin-root';

// Clause B. Substitute the anchor with a sentinel root, resolve, and require the
// result to stay inside it. Tokens carrying template placeholders cannot be
// resolved literally, so they are checked lexically for `..` instead.
function escapesRoot(token) {
  const body = normalizePath(token).replace(new RegExp(`^(?:${ANCHOR})/`), '');
  if (/[{}|$]/.test(body)) return body.split('/').includes('..');
  const resolved = path.resolve(ROOT_SENTINEL, body);
  return resolved !== ROOT_SENTINEL && !resolved.startsWith(ROOT_SENTINEL + path.sep);
}

// Symlink escape: an anchored, lexically-contained path can still point out of the
// root if a component is a symlink. Only checkable for targets that exist.
//
// `root` is a parameter rather than a closed-over constant so the fixture can use a
// throwaway root outside the repository. Planting a symlink inside the real root
// races any test that copies the repo tree — `node --test` runs files in parallel
// processes — and a flaky security guard is worse than a missing one: it teaches
// people to re-run until green.
function escapesViaSymlink(token, root = ROOT) {
  const body = normalizePath(token).replace(new RegExp(`^(?:${ANCHOR})/`), '');
  if (/[{}|$]/.test(body)) return false;
  const target = path.join(root, body);
  if (!fs.existsSync(target)) return false;
  const real = fs.realpathSync(target);
  const realRoot = fs.realpathSync(root);
  return real !== realRoot && !real.startsWith(realRoot + path.sep);
}

// Resolve a token for real, from a given cwd, exactly as a runtime agent would.
// Re-running the classifier tells you only what the classifier already believes;
// this performs the resolution and asks which file the instruction lands on. It is
// the second, independent layer, and it is shared by every fixture that needs it so
// no two of them can disagree about what resolution means.
function resolveAsAgentWould(token, cwd) {
  if (ANCHORED_TOKEN.test(token)) {
    return path.resolve(ROOT, token.replace(new RegExp(`^(?:${ANCHOR})/`), ''));
  }
  return path.resolve(cwd, token.replace(/^\.\//, ''));       // unanchored → cwd
}

// Returns violations on a line: {form, token, why}. Empty when the line is clean.
function shadowableTokens(line, sourceFile = path.join(ROOT, 'AGENTS.md'), root = ROOT) {
  const out = [];
  for (const [form, re] of FORMS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line))) {
      const token = normalizePath(m[2] === undefined ? m[1] : m[1] + m[2]);
      if (!ANCHORED_TOKEN.test(token)) out.push({ form, token, why: 'unanchored' });
      else if (escapesRoot(token)) out.push({ form, token, why: 'escapes plugin root' });
      else if (escapesViaSymlink(token, root)) out.push({ form, token, why: 'escapes via symlink' });
    }
  }
  out.push(...bareBasenameHits(line));
  out.push(...jsModuleLoadHits(line));
  out.push(...denyByDefaultHits(line, sourceFile, root));
  // A token can match several FORMS plus deny-by-default; report each once.
  const seen = new Set();
  return out.filter((v) => {
    const key = `${v.token}|${v.why}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Indented too: fences nested in a list item or a numbered step are still fences.
const FENCE = /^[ \t]*```/gm;

test('every scanned markdown file has balanced code fences', () => {
  // The indent class, pinned on the axis rather than on the tree. Fences nested in
  // a list item or a numbered step are still fences, and three scanned documents
  // use them — but every one of those blocks is balanced, so dropping `[ \t]*`
  // removes an even number of matches from each file and the parity check below
  // sees nothing. A real-file sweep therefore cannot pin this clause; running the
  // production constant against an indented marker can.
  FENCE.lastIndex = 0;
  assert.ok(FENCE.test('   ```bash'),
    'an indented fence is still a fence — a column-0-only matcher counts none of '
    + 'the blocks nested in list items, and a truncation inside one goes unseen');
  FENCE.lastIndex = 0;

  const unbalanced = [];
  for (const file of markdownFiles()) {
    const fences = (fs.readFileSync(file, 'utf8').match(FENCE) || []).length;
    if (fences % 2 !== 0) unbalanced.push(`${path.relative(ROOT, file)} (${fences})`);
  }
  assert.deepEqual(unbalanced, [],
    `unclosed code fence — a split or edit truncated a fenced block:\n  ${unbalanced.join('\n  ')}`);
});

test('the always-loaded agent guides are in the scan set', () => {
  // Asserting membership means the coverage claim is checked by the suite rather
  // than by a commit message.
  //
  // Root-level entries in ALWAYS_LOADED have no separator, so a Windows emulation
  // over them alone cannot fail — it would be a decorative assertion. The
  // derivation is pinned against a real nested document instead, which is where the
  // spelling actually diverges. `relative` is a seam, not a switch: it defaults to
  // the host's and turns nothing off.
  const scanKeys = (rel = path.relative) =>
    markdownFiles().map((f) => normalizePath(rel(ROOT, f)));
  const scanned = scanKeys();
  for (const doc of ALWAYS_LOADED) {
    assert.ok(fs.existsSync(path.join(ROOT, doc)), `${doc} must exist to be scanned`);
    assert.ok(scanned.includes(doc), `${doc} must be in the shadow-guard scan set`);
  }
  // Coverage, stated against the shipped set rather than against SCANNED_DIRS.
  // Looping over SCANNED_DIRS to check that each contributes is self-referential:
  // shrink the list to `['skills']` and the loop shrinks with it, so agents/ and
  // commands/ silently leave the scan while the assertion stays green — measured.
  // Every shipped `.md` that lives under a directory is an instruction surface, and
  // the root-level ones are README/CHANGELOG-class metadata plus the two guides
  // ALWAYS_LOADED names explicitly. So the containment claim is: no nested shipped
  // document is outside the scan.
  const shippedDocs = [...PLUGIN_FILES].filter((k) => k.endsWith('.md') && k.includes('/'));
  assert.ok(shippedDocs.length > 0,
    'the shipped set holds no nested document — the next assertion proves nothing');
  assert.deepEqual(shippedDocs.filter((k) => !scanned.includes(k)), [],
    'a shipped instruction document is outside the shadow-guard scan set');
  const nested = scanned.find((k) => k.includes('/'));
  assert.ok(nested,
    'the scan set must hold a nested document, or the next assertion proves nothing');
  assert.ok(scanKeys(path.win32.relative).includes(nested),
    `the Windows spelling of ${nested} must be the same key as the host's — `
    + 'otherwise every membership check against a slash literal misses there');
});

test('no read or exec instruction can be shadowed from the target workspace', () => {
  const violations = [];
  for (const file of markdownFiles()) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const v of shadowableTokens(line, file)) {
        violations.push(`${path.relative(ROOT, file)}:${i + 1}  [${v.form}] ${v.token} — ${v.why}`);
      }
    });
  }
  assert.deepEqual(violations, [],
    'plugin path read or executed outside the plugin root — anchor it at '
    + `${ANCHOR_LITERAL} and keep it inside the root:\n  ${violations.join('\n  ')}`);
});

// One case per instruction form, so the coverage claim is itself tested. A form
// with no case here is a form the guard does not enforce. `safe` is null for
// js-module-load: that form has no safe textual spelling in this repo, and the
// dedicated test below pins that the anchored spelling is refused too.
const FORM_CASES = [
  ['interpreter-exec', 'node hooks/scripts/public-route.mjs --help',
    `node "${ANCHOR_LITERAL}/hooks/scripts/public-route.mjs" --help`],
  ['read-verb', 'Read `references/review-execution.md` and apply it',
    `Read \`${ANCHOR_LITERAL}/skills/deep-review-workflow/references/review-execution.md\` and apply it`],
  ['direct-exec', 'source hooks/scripts/extract-fp-doctrine.sh',
    `source ${ANCHOR_LITERAL}/hooks/scripts/extract-fp-doctrine.sh`],
  ['executable-token', 'the runtime lives at `hooks/scripts/public-route.mjs`',
    `the runtime lives at \`${ANCHOR_LITERAL}/hooks/scripts/public-route.mjs\``],
  ['bare-basename', 'Read(`review-execution.md`)',
    `Read(\`${ANCHOR_LITERAL}/skills/deep-review-workflow/references/review-execution.md\`)`],
  ['dot-relative', 'Read `../deep-review-workflow/references/review-execution.md`',
    `Read \`${ANCHOR_LITERAL}/skills/deep-review-workflow/references/review-execution.md\``],
  ['js-module-load', 'const cfg = require("hooks/scripts/lib/config.mjs");', null],
];

test('every enumerated instruction form is enforced', () => {
  for (const [form, unsafe, safe] of FORM_CASES) {
    assert.ok(shadowableTokens(unsafe).length > 0, `${form}: guard must flag — ${unsafe}`);
    if (safe === null) continue;
    assert.deepEqual(shadowableTokens(safe), [], `${form}: guard must accept — ${safe}`);
  }
});

test('a JS module load is refused in every spelling, anchored or not', () => {
  for (const line of [
    'const cfg = require("hooks/scripts/lib/config.mjs");',
    `const cfg = require("${ANCHOR_LITERAL}/hooks/scripts/lib/config.mjs");`,
    'const cfg = require("${CLAUDE_PLUGIN_ROOT}/hooks/scripts/lib/config.mjs");',
    'import cfg from `${CLAUDE_PLUGIN_ROOT}/hooks/scripts/lib/config.mjs`;',
  ]) {
    assert.ok(jsModuleLoadHits(line).length > 0, `must flag JS module load: ${line}`);
  }
  assert.deepEqual(jsModuleLoadHits('const { readFileSync } = require("node:fs");'), [],
    'a Node built-in specifier names no path and must pass');
});

test('anchored paths that escape the plugin root are rejected (containment)', () => {
  // Clause B. Each carries a valid anchor prefix and still leaves the root, so a
  // prefix-only check passes both.
  const traversals = [
    `Read \`${ANCHOR_LITERAL}/../workspace/evil.md\``,
    `node "${ANCHOR_LITERAL}/../workspace/evil.js"`,
  ];
  for (const line of traversals) {
    const hits = shadowableTokens(line);
    assert.ok(hits.length > 0, `containment must reject: ${line}`);
    assert.equal(hits[0].why, 'escapes plugin root', `wrong reason for: ${line}`);
  }
  // A `..` that stays inside the root is fine.
  assert.deepEqual(
    shadowableTokens(`Read \`${ANCHOR_LITERAL}/skills/deep-review/../deep-review-loop/SKILL.md\``), [],
    'in-root traversal must be accepted');
});

test('the root-metadata exemption cannot cover a nested path', () => {
  // ROOT_METADATA is the one relaxation in this guard, and it is derived rather
  // than hand-listed here, so what needs pinning is its BOUND. Losing an entry only
  // over-flags — fail-closed, and the sweep would say so. Gaining a multi-segment
  // entry is the fail-open direction: `skills/deep-review/SKILL.md` in this set
  // exempts the single most shadowable path in the plugin, and every other test
  // stays green because deny-by-default simply never sees the token.
  const nested = [...ROOT_METADATA].filter((k) => k.includes('/'));
  assert.deepEqual(nested, [],
    'the descriptive-metadata pass is for single-segment root files only — a '
    + `multi-segment entry silences deny-by-default for a real plugin path:\n  ${nested.join('\n  ')}`);
  // Non-vacuity: the set is not simply empty, so the bound is a real constraint.
  assert.ok(ROOT_METADATA.size > 0,
    'ROOT_METADATA is empty — the bound above would hold for a set that exempts nothing');
});

test('mixed lines fail on the bare token', () => {
  // A line-level anchor check passes this; the token-level check must not.
  const line = `Read \`${ANCHOR_LITERAL}/skills/deep-review/SKILL.md\` then Read \`../deep-review-loop/SKILL.md\``;
  const hits = shadowableTokens(line);
  assert.equal(hits.length, 1, `exactly the bare token must be flagged, got ${JSON.stringify(hits)}`);
  assert.equal(hits[0].why, 'unanchored');
});

test('a malicious workspace cannot shadow any instruction the plugin issues', () => {
  // End-to-end statement of the invariant. Plant shadows in a fake target workspace
  // for every file the plugin ships, then confirm that no instruction in the repo
  // would resolve to one of them. Because every instruction is anchored, cwd is
  // irrelevant — which is the property under test, not an accident of this fixture.
  const evil = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-evil-workspace-'));
  try {
    // Derived, not enumerated. A hand-written plant list only covers the paths
    // someone remembered; planting every shipped file at its repo-relative path
    // makes coverage follow the tree.
    //
    // Repo-relative paths only. Planting bare basenames as well was tried and
    // reverted in the reference implementations: a document that merely mentions a
    // shipped basename in prose then registers as a landing. That shape is handled
    // by detection instead (BARE_BASENAME / BARE_EXEC_BASENAME), where a read verb
    // or an interpreter is what makes it an instruction.
    for (const rel of PLUGIN_FILES) {
      const dest = path.join(evil, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (!fs.existsSync(dest)) fs.writeFileSync(dest, '# SHADOW — must never be read\n');
    }

    // Excluding directory landings is safe only while no shipped SUBdirectory is a
    // Node LOAD_AS_DIRECTORY target. `<dir>/index.js` or `<dir>/package.json#main`
    // would make a planted DIRECTORY reachable by name, and nothing else would
    // notice, because `isFile()` would keep skipping it.
    //
    // The separator in the pattern is deliberate and is the one deviation from the
    // reference implementation: this repo ships a root `package.json` (it has no
    // `files` field, so the shipped set is tracked-minus-tests and includes it).
    // The root is not nameable by any token this guard extracts — a repo-relative
    // path cannot spell it, and `require(".")` is not path-shaped — so only a
    // subdirectory turning loadable can hide a reachable shadow behind isFile().
    assert.deepEqual(
      [...PLUGIN_FILES].filter((k) => /\/(index\.[cm]?js|package\.json)$/.test(k)).sort(),
      [],
      'a shipped subdirectory just became loadable by name — the isFile() landing '
      + 'filter now hides a reachable shadow, and must be revisited');

    // A landing must be a FILE. Planting every shipped path creates the directories
    // above it, so `existsSync` alone reports a hit for any prose that names a
    // shipped directory — `hooks/scripts`, say — where nothing shadowable was
    // planted at all.
    const landsOnShadow = (target) => target.startsWith(evil + path.sep)
      && fs.existsSync(target) && fs.statSync(target).isFile();

    // Both halves of that predicate, pinned before the sweep runs — the sweep's own
    // result cannot pin them, because a `[]` is what a silent predicate and a clean
    // corpus produce alike. The file and the directory are derived from the index
    // for the same reason the plants are.
    const plantedFile = [...PLUGIN_FILES].find((k) => k.includes('/'));
    assert.ok(landsOnShadow(path.join(evil, plantedFile)),
      `the plant loop must have written ${plantedFile} — with nothing planted, an `
      + 'empty sweep result is a property of the fixture rather than of the documents');
    const plantedDir = plantedFile.split('/').slice(0, -1).join('/');
    assert.equal(landsOnShadow(path.join(evil, plantedDir)), false,
      'a directory created by the plant loop must not count as a landing — otherwise '
      + 'any prose naming a shipped directory reports as a reachable shadow');

    const landed = [];
    for (const file of markdownFiles()) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        for (const token of scopedTokens(line)) {
          const target = resolveAsAgentWould(token, evil);
          if (landsOnShadow(target)) {
            landed.push(`${path.relative(ROOT, file)}:${i + 1}  ${token} → ${target}`);
          }
        }
      });
    }
    assert.deepEqual(landed, [],
      `these instructions resolve onto a planted shadow file:\n  ${landed.join('\n  ')}`);

    // Non-vacuity: the same resolution, given an unanchored token, does land on the
    // shadow — so an empty result above is a property of the documents, not of a
    // resolver that never finds anything. Derived from the index for the same
    // reason the plants are.
    const controlToken = [...PLUGIN_FILES].find((k) => k.endsWith('.md') && k.includes('/'));
    assert.ok(controlToken, 'the shipped set must hold a nested document to control with');
    assert.ok(landsOnShadow(resolveAsAgentWould(controlToken, evil)),
      'fixture is vacuous — an unanchored token must land on the planted shadow');
  } finally {
    fs.rmSync(evil, { recursive: true, force: true });
  }
});

test('a separator run reaches the planted file, not just the classifier', () => {
  // The defect this pins is invisible to a failure count. With a one-character
  // separator element in PATH_TOKEN, a run-spelled path (`hooks\\scripts\\x.mjs`)
  // still makes the classifier report — a FORM matches the raw text — while the
  // reachability fixture goes blind, because scopedTokens dies at the second
  // separator and yields only the bare basename. Counting failures reads that as
  // "caught"; it is the layer that proves an instruction *actually lands on a
  // planted file* that has stopped working, and that is the only layer that
  // demonstrates the attack rather than describing it.
  //
  // So the two layers are asserted separately, by what each concludes.
  const evil = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-run-evil-'));
  try {
    fs.mkdirSync(path.join(evil, 'hooks', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(evil, 'hooks', 'scripts', 'public-route.mjs'),
      'process.stdout.write("SHADOW");\n');

    for (const [label, line] of [
      ['single slash', 'node hooks/scripts/public-route.mjs --help'],
      ['single backslash', 'node hooks\\scripts\\public-route.mjs --help'],
      ['backslash run', 'node hooks\\\\scripts\\\\public-route.mjs --help'],
      ['slash run', 'node hooks//scripts//public-route.mjs --help'],
      ['mixed run', 'node hooks\\/scripts\\/public-route.mjs --help'],
    ]) {
      assert.ok(shadowableTokens(line).length > 0,
        `layer 1 (classifier) must flag: ${label} — ${line}`);

      const landed = [...scopedTokens(line)]
        .map((t) => resolveAsAgentWould(t, evil))
        .filter((t) => t.startsWith(evil + path.sep) && fs.existsSync(t) && fs.statSync(t).isFile());
      assert.ok(landed.length > 0,
        `layer 2 (reachability) must land on the planted shadow: ${label} — ${line}. `
        + `scopedTokens yielded ${JSON.stringify([...scopedTokens(line)])}`);
    }

    // Non-vacuity for layer 2: an anchored spelling of the same path must NOT land
    // in the workspace, so "landed" is a property of the token and not of a
    // resolver that points everything at the evil root.
    const anchored = resolveAsAgentWould(
      `${ANCHOR_LITERAL}/hooks/scripts/public-route.mjs`, evil);
    assert.equal(anchored.startsWith(evil + path.sep), false,
      'an anchored token must resolve into the plugin, never the workspace');
  } finally {
    fs.rmSync(evil, { recursive: true, force: true });
  }
});

test('markdown link destinations are never the plugin-root placeholder', () => {
  // The mirror image of the anchor rule. Markdown does not interpolate, so an
  // anchored link destination is a literal broken URL. Link targets are an
  // exception class in the guard above; this asserts the exception is actually
  // honoured in the documents.
  const broken = [];
  for (const file of markdownFiles()) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const re = /\]\((\{plugin_root\}[^)]*|\$\{[^)]*)\)/g;
      let m;
      while ((m = re.exec(line))) broken.push(`${path.relative(ROOT, file)}:${i + 1}  ](${m[1]})`);
    });
  }
  assert.deepEqual(broken, [],
    'markdown link destination uses a placeholder that nothing expands — use a '
    + `source-relative path instead:\n  ${broken.join('\n  ')}`);
});

test('a path the plugin never ships carries the sentence that makes it safe', () => {
  // Self-consistency axis. The rule this guard adds — "a bare plugin path resolves
  // against the analysed project" — is violated by any line naming a gitignored
  // path, because such a path can resolve *nowhere else*. Deny-by-default cannot
  // see it: that rule only flags what resolves inside the plugin. Writing a rule is
  // not enforcing it, so the exemption is asserted rather than assumed.
  const violations = [];
  for (const [token, clauses] of NON_SHIPPED) {
    assert.ok(!PLUGIN_FILES.has(token),
      `${token} is listed as non-shipped but is in the shipped file set`);
    for (const file of markdownFiles()) {
      const body = fs.readFileSync(file, 'utf8');
      if (!body.includes(token)) continue;
      const flat = flatten(body);
      for (const clause of clauses) {
        if (!clause.test(flat)) {
          violations.push(`${path.relative(ROOT, file)} names ${token} but is missing: ${clause.source}`);
        }
      }
    }
  }
  assert.deepEqual(violations, [],
    `a non-shipped path is named without every clause that makes it safe to read:\n  ${violations.join('\n  ')}`);
});

// Derived from `.gitignore`, not hand-listed. A hand-listed pair matched the ignore
// file exactly on the day it was written and would have leaked silently the first
// time a third entry was added — and this repo already has four.
const IGNORED_DIRS = (() => {
  const body = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  return body.split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!') && line.endsWith('/'))
    .map((line) => line.replace(/\/$/, ''));
})();

// Not every gitignored directory is a leak when a document names it. The rule's
// premise is "this can only ever resolve against the analysed project, so naming it
// hands the instruction there" — and for a plugin's declared output root, resolving
// against the analysed project is the CONTRACT.
//
// Three arms, each with a stated authority, and no list of variable names:
//
// (1) ASK THE CODE — a directory this plugin WRITES into a project is its own output
//     root. Writing is the discriminator, not joining: a sibling's release gate joins
//     `docs` onto a project root and only READS it, because `docs/` belongs to
//     whatever project is being analysed. Keying on joins classified `docs/` as an
//     output root there and silenced the rule for the exact class it exists for.
// (2) ASK THE CONVENTION — `.deep-*` is the suite's name for a plugin output root.
//     This covers a SIBLING's root, which this plugin never writes but a document may
//     correctly tell an agent to read in the project.
// (3) ASK THE HOST — `.claude` is Claude Code's own per-project directory, referenced
//     by several plugins and always living in the analysed project.
//
// Arms (2) and (3) were missing here while a sibling had them, and the two repos
// disagreed about `.deep-loop/` with the disagreement pinned by assertions on both
// sides. Aligned.
const WORKSPACE_OUTPUT_DIRS = (() => {
  const WRITE = /(mkdirSync|writeFileSync|appendFileSync|createWriteStream|rmSync|cpSync|renameSync)/;
  const out = new Set();
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.[cm]?js$/.test(e.name) || /\.test\.[cm]?js$/.test(e.name)) continue;
      const body = fs.readFileSync(p, 'utf8');
      for (const d of IGNORED_DIRS) {
        if (out.has(d)) continue;
        const re = new RegExp(`['"\`]${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`, 'g');
        let m;
        while ((m = re.exec(body))) {
          if (WRITE.test(body.slice(Math.max(0, m.index - 260), m.index + 260))) { out.add(d); break; }
        }
      }
    }
  };
  ['hooks', 'scripts', 'runtime', 'lib'].forEach((s) => walk(path.join(ROOT, s)));
  for (const d of IGNORED_DIRS) {
    if (d.startsWith('.deep-') || d === '.claude') out.add(d);
  }
  return out;
})();

const GITIGNORED_DIRS = IGNORED_DIRS.filter((d) => !WORKSPACE_OUTPUT_DIRS.has(d));

test('the non-shipped directory list is derived from .gitignore, not guessed', () => {
  // Non-vacuity: the sweep below is only meaningful if this actually found the
  // directories that motivated it. Asserted against the RAW derivation — the
  // workspace-output carve-out runs after it, and its own test owns that step.
  assert.ok(IGNORED_DIRS.length > 0, '.gitignore yielded no ignored directories');
  for (const dir of ['docs', '.deep-review']) {
    assert.ok(IGNORED_DIRS.includes(dir),
      `${dir} must be recognised as non-shipped — it is where the blind spot was found`);
  }
  // And the derivation must not be a two-entry coincidence: this repo ignores more
  // than the pair above, and a hand list is exactly what would have stopped there.
  assert.ok(IGNORED_DIRS.length > 2,
    `the derivation found only ${JSON.stringify(IGNORED_DIRS)} — a hand list would `
    + 'have covered that many, so this proves nothing about deriving');
});

test('the workspace-output carve-out is derived from the runtime, and is narrow', () => {
  // The carve-out is the one place this rule can be turned off, so it gets its own
  // test rather than living only inside the sweep.
  assert.ok(WORKSPACE_OUTPUT_DIRS.has('.deep-review'),
    'the declared report root must be recognised — naming it is the contract');
  // `.deep-loop` and `.claude` are output roots here too — a sibling's root and the
  // host's project directory. Asserting the opposite is what made two repos in the
  // same suite disagree, with the disagreement pinned on both sides.
  assert.ok(WORKSPACE_OUTPUT_DIRS.has('.deep-loop'), "a sibling's output root is not a leak");
  assert.ok(WORKSPACE_OUTPUT_DIRS.has('.claude'), "the host's project directory is not a leak");
  for (const d of ['docs']) {
    assert.ok(!WORKSPACE_OUTPUT_DIRS.has(d),
      `${d} is gitignored with no runtime that builds it from the analysed repo, so `
      + 'it must stay in scope — a carve-out that covers it is a blanket exemption');
  }
  assert.ok(GITIGNORED_DIRS.length > 0,
    'the carve-out must not empty the rule — that would silence it entirely');
  // Non-vacuity in the other direction: the carve-out has to actually remove
  // something, or this whole derivation is decoration.
  assert.ok(GITIGNORED_DIRS.length < IGNORED_DIRS.length,
    'nothing was carved out — then the runtime probe found nothing and the rule is '
    + 'unchanged, which is not what its comment claims');
});

test('no undeclared path under a non-shipped directory is named', () => {
  // The generalisation of the caveat rule. Anything under a gitignored directory is
  // unresolvable in an installed plugin and therefore resolves only against the
  // workspace. Each one must be declared in NON_SHIPPED, which forces the caveat
  // test to cover it.
  const escaped = GITIGNORED_DIRS.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  // Either separator. This check is lexical over raw lines on purpose — that is what
  // makes it immune to any index blind spot — and for the same reason normalizePath
  // never reaches it, so `\` has to be spelled out here.
  //
  // Negative lookbehind, not a positive prefix list. Enumerating the characters that
  // may precede a path means every character nobody thought of is a bypass:
  // `**docs/NOT_DECLARED.md**` and `[docs/OTHER.md](…)` — bold text and link text,
  // both ordinary markdown — slip past a list of space/backtick/quote/paren.
  // Asserting only that the match does not start mid-token covers every prefix at
  // once.
  const NON_SHIPPED_DIRS = new RegExp(String.raw`(?<![A-Za-z0-9._\\/-])((?:${escaped})[\\/][A-Za-z0-9._\\/-]+)`, 'g');
  // Both spellings, on the axis rather than on the tree.
  for (const spelling of ['docs/backlog.md', 'docs\\backlog.md']) {
    NON_SHIPPED_DIRS.lastIndex = 0;
    assert.ok(NON_SHIPPED_DIRS.exec(`See \`${spelling}\` for the rest.`),
      `undeclared-path check must see both spellings: ${spelling}`);
  }
  // And the lookbehind, on the axis too. The corpus happens to write these paths
  // after a backtick or a space, so a real-file sweep gives the prefix rule no
  // coverage at all: swap the lookbehind for a prefix list and nothing changes.
  // Bold text and link text are ordinary markdown and are what a prefix list misses.
  for (const context of ['**docs/HIDDEN.md**', '[docs/HIDDEN.md](x)', '(docs/HIDDEN.md)']) {
    NON_SHIPPED_DIRS.lastIndex = 0;
    assert.ok(NON_SHIPPED_DIRS.exec(context),
      `undeclared-path check must see every prefix, not a listed few: ${context}`);
  }
  // The other side of the lookbehind: it must not start a match mid-token, or a
  // word ending in the directory name reports as a path.
  NON_SHIPPED_DIRS.lastIndex = 0;
  assert.equal(NON_SHIPPED_DIRS.exec('the subdocs/thing is unrelated'), null,
    'a match must not start mid-token');

  const undeclared = [];
  for (const file of markdownFiles()) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      NON_SHIPPED_DIRS.lastIndex = 0;
      let m;
      while ((m = NON_SHIPPED_DIRS.exec(line))) {
        if (!NON_SHIPPED.has(m[1])) {
          undeclared.push(`${path.relative(ROOT, file)}:${i + 1}  ${m[1]}`);
        }
      }
    });
  }
  assert.deepEqual(undeclared, [],
    'a path under a gitignored, never-shipped directory can only resolve against '
    + `the analysed project — declare it in NON_SHIPPED or drop it:\n  ${undeclared.join('\n  ')}`);
});

test('a backslash separator does not hide a path from the guard', () => {
  // Windows is a supported host, so a backslash path is a legitimate spelling and
  // not a typo — and in the reference implementations one character bypassed the
  // whole deny-by-default invariant: the slash form produced failures and the
  // backslash form produced none, for the same unanchored reference to the same
  // real file.
  //
  // Mixed separators matter as much as pure backslash: a rule that learned to
  // recognise "a backslash path" as a second shape would still miss
  // `hooks\scripts/public-route.mjs`. That is why the fix normalises at
  // tokenisation instead of teaching each matcher a new form.
  const TABLE = [
    ['unanchored slash', 'Run `node hooks/scripts/public-route.mjs` to start.'],
    ['unanchored backslash', 'Run `node hooks\\scripts\\public-route.mjs` to start.'],
    ['read-verb slash', 'Read `skills/deep-review/SKILL.md`'],
    ['read-verb backslash', 'Read `skills\\deep-review\\SKILL.md`'],
    ['mixed separators', 'Run `node hooks\\scripts/public-route.mjs` to start.'],
    ['read-verb mixed', 'Read `skills/deep-review\\SKILL.md` first.'],
    // The rows below carry no read verb and no runnable extension, so the
    // executable-token FORM cannot cover for the tokeniser. They are the only rows
    // that actually exercise the `+` on PATH_TOKEN's separator class.
    ['slash run, .md, no verb', 'The workflow lives at skills//deep-review-workflow//SKILL.md today.'],
    ['backslash run, .md, no verb', 'The workflow lives at skills\\\\deep-review-workflow\\\\SKILL.md today.'],
    ['mixed run, .md, no verb', 'The workflow lives at skills\\/deep-review-workflow/\\SKILL.md today.'],
  ];
  for (const [label, line] of TABLE) {
    assert.ok(shadowableTokens(line).length > 0, `${label} must be flagged: ${line}`);
  }

  // An anchored traversal written with backslashes is still a traversal, and must be
  // rejected for that reason rather than as "unanchored". Asserting the reason is
  // what keeps this row from passing for the wrong cause: with normalizePath removed
  // the token stays `{plugin_root}\..\…`, fails ANCHORED_TOKEN, and is flagged —
  // correctly, but as an anchoring failure.
  const traversal = shadowableTokens(`node "${ANCHOR_LITERAL}\\..\\workspace\\evil.json"`);
  assert.ok(traversal.length > 0, 'anchored backslash traversal must be flagged');
  assert.equal(traversal[0].why, 'escapes plugin root',
    `traversal must fail on containment, not anchoring: ${JSON.stringify(traversal)}`);

  // Escape parity: a doubled backslash is how the same path appears inside a string
  // literal, and separator runs collapse, so it resolves identically.
  assert.ok(shadowableTokens('const p = "hooks\\\\scripts\\\\envelope.js";').length > 0,
    'an escaped backslash path must be flagged too');

  // PER-AXIS ISOLATION. The rows above are caught by several rules at once, so they
  // prove the bug is closed without proving which piece closed it. Each case below
  // is chosen so exactly one piece can see it.

  // PATH_TOKEN + the normalise-before-exemption ordering, isolated. No read verb, so
  // no FORM matches, and a basename ROOT_METADATA exempts on its own — so if the
  // token is not extracted whole and canonicalised before the exemption lookup,
  // nothing sees it at all.
  assert.ok(
    shadowableTokens('워크플로우 정본은 `skills\\deep-review\\SKILL.md` 이다.').length > 0,
    'deny-by-default must extract a backslash path whole, not just its basename');

  // ANY_ROOT/REL separator, isolated. Deny-by-default asks whether a token resolves
  // inside the plugin, so a path to a file that does not exist is invisible to it —
  // only a FORM can match, and only if the separator directly after the root
  // directory is accepted.
  assert.ok(shadowableTokens('Read `skills\\missing.md` before starting.').length > 0,
    'a FORM must accept a backslash directly after the root directory');

  // PATH_BODY separator, isolated. Slash after the root so ANY_ROOT matches either
  // way; the backslash is inside the body, and the file does not exist so
  // deny-by-default cannot cover for it.
  assert.ok(shadowableTokens('Read `skills/zzz\\missing.md` before starting.').length > 0,
    'a FORM must match a backslash inside the path body');

  // executable-token, isolated. It has its own inline copy of the root and body
  // patterns rather than sharing ANY_ROOT/PATH_BODY, so the other FORMS learning `\`
  // does not teach it anything. No interpreter, no read verb, deliberately not
  // `from` — that word alone puts a module load on the line — and a file that does
  // not exist, so this rule is the only one that can see it.
  for (const line of [
    'the runtime is at `hooks\\scripts\\missing-runtime.mjs`',
    'the helper `hooks\\scripts\\missing-helper.sh` is invoked at Stop',
  ]) {
    const hits = shadowableTokens(line);
    assert.deepEqual(hits.map((h) => h.form), ['executable-token'],
      `executable-token must be the rule that catches this, alone: ${line}`);
  }

  assert.deepEqual(
    shadowableTokens(`Read \`${ANCHOR_LITERAL}\\skills\\deep-review\\SKILL.md\``), [],
    'an anchored backslash path must be accepted, not flagged as unanchored');
});

test('normalising separators does not promote prose into a path', () => {
  // Collapsing separator runs makes over-flagging the failure mode to watch, so the
  // text that must stay silent is pinned. But "produces no violation" has two
  // mechanisms behind it, and asserting only the outcome hides which one is
  // load-bearing. So each line declares its mechanism and is checked against it.

  // A. The tokeniser must not see a path here at all. Escape sequences and regex
  //    bodies are the shapes most at risk once `\` is a separator.
  for (const line of [
    'escape a quote with \\" and a backslash with \\\\',
    'Use `\\n` for a newline and `\\t` for a tab.',
    'A literal backslash is written `\\\\` in a JS string literal.',
    'The validator matches /^[A-Za-z]+\\/[a-z-]+$/ against each entry.',
  ]) {
    assert.deepEqual([...scopedTokens(line)], [],
      `no path token may be extracted from: ${line}`);
    assert.deepEqual(shadowableTokens(line), [], `must not be flagged: ${line}`);
  }

  // B. Here the tokeniser does extract something — a Windows path quoted inside user
  //    input is genuinely path-shaped — and it stays silent only because it resolves
  //    to no plugin file. That is a claim about the rule, so it gets the non-vacuity
  //    check: declare those exact tokens plugin files and the line must be flagged.
  //    Nothing is stubbed; only the file set the rule consults is changed, so what
  //    runs is the real classifier.
  for (const [line, expected] of [
    ['Windows paths in user input (`C:\\Users\\me\\project`) are normalised before use.',
      ['Users/me/project']],
    ['The workspace was at `D:\\repos\\acme\\notes.md` on that machine.',
      ['repos/acme/notes.md']],
    ['const p = "C:\\\\Users\\\\me\\\\notes.md";', ['Users/me/notes.md']],
  ]) {
    assert.deepEqual([...scopedTokens(line)], expected,
      `separator runs must collapse to one canonical token: ${line}`);
    assert.deepEqual(shadowableTokens(line), [], `must not be flagged: ${line}`);

    for (const t of expected) PLUGIN_FILES.add(t);
    try {
      assert.ok(shadowableTokens(line).length > 0,
        'vacuous negative — this line stays silent even when its tokens name real '
        + `plugin files, so asserting its silence proves nothing: ${line}`);
    } finally {
      for (const t of expected) PLUGIN_FILES.delete(t);
    }
  }
});

test('the anchor cannot be spelled as a shell variable anywhere', () => {
  // The bypass the reference implementation closes with a `non-expanding-anchor`
  // check hung off a list of commands — which misses `cp`, `mv`, `install` and any
  // wrapper, enumeration creeping back in on a second axis. This plugin instead bans
  // the shell spelling outright in every scanned file (the sweep below), because no
  // shell is involved: `{plugin_root}` is substituted by the agent while reading
  // prose, so quoting cannot change the outcome either way.
  const line = "cp '${CLAUDE_PLUGIN_ROOT}/hooks/scripts/public-route.mjs' /tmp/x";
  const offenders = [];
  for (const spelling of ANCHOR_MISSPELLINGS) {
    if (spelling.test(line)) offenders.push(spelling.source);
  }
  assert.ok(offenders.length > 0,
    'the single-anchor-spelling rule must reject the shell spelling regardless of the command');
  // And it is verb-agnostic: no command appears in this line at all.
  assert.ok(shadowableTokens('hooks/scripts/public-route.mjs 를 참조한다').length > 0,
    'deny-by-default must flag a bare plugin path with no command verb present');
});

test('an anchored path that leaves the root through a symlink is rejected', () => {
  // `escapes via symlink` is produced on two code paths, and containment only ever
  // exercises the lexical `..` form. path.resolve is lexical, so an anchored,
  // `..`-free path whose component is a symlink passes every other check and still
  // lands outside the plugin.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-symlink-outside-'));
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-symlink-root-'));
  try {
    fs.writeFileSync(path.join(outside, 'evil.md'), '# SHADOW — outside the plugin root\n');
    fs.mkdirSync(path.join(fakeRoot, 'skills'), { recursive: true });
    fs.symlinkSync(path.join(outside, 'evil.md'), path.join(fakeRoot, 'skills', 'evil.md'));
    fs.writeFileSync(path.join(fakeRoot, 'skills', 'ok.md'), '# in-root\n');
    const token = `${ANCHOR_LITERAL}/skills/evil.md`;

    // Non-vacuity: the token is anchored and lexically contained, so every other
    // clause accepts it. Only the symlink check can reject it.
    assert.ok(ANCHORED_TOKEN.test(token), 'fixture token must be anchored');
    assert.equal(escapesRoot(token), false, 'fixture token must be lexically contained');

    // Both production sites: the FORMS path and the deny-by-default path.
    const viaForm = shadowableTokens(`Read \`${token}\``, undefined, fakeRoot);
    assert.ok(viaForm.some((v) => v.why === 'escapes via symlink'),
      `read-verb path must reject the symlink: ${JSON.stringify(viaForm)}`);
    const viaDeny = denyByDefaultHits(`증명은 \`${token}\` 를 따른다`, path.join(ROOT, 'AGENTS.md'), fakeRoot);
    assert.ok(viaDeny.some((v) => v.why === 'escapes via symlink'),
      `deny-by-default path must reject the symlink: ${JSON.stringify(viaDeny)}`);

    // A real in-root target of the same shape is still accepted, so the rule is
    // about where the link points and not about the directory it sits in.
    assert.deepEqual(
      shadowableTokens(`Read \`${ANCHOR_LITERAL}/skills/ok.md\``, undefined, fakeRoot), [],
      'a real in-root file must still be accepted');
  } finally {
    fs.rmSync(fakeRoot, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// The spellings that are NOT this plugin's anchor. Shared by the mechanism test
// above and the document sweep below so the two cannot disagree about what a second
// spelling is.
const ANCHOR_MISSPELLINGS = [
  /\$\{CLAUDE_PLUGIN_ROOT\}/,
  /<PLUGIN_ROOT>/,
  /\$CLAUDE_PLUGIN_ROOT\b/,
];

test('the plugin uses exactly one anchor spelling', () => {
  // A shell- or JS-expanded anchor is not a stylistic alternative here, and this is
  // the test that makes the alternative visible at all. `${CLAUDE_PLUGIN_ROOT}/x` is
  // invisible to every other rule in this file: ANCHORED_TOKEN does not recognise
  // it, so it is not judged for containment; deny-by-default cannot resolve it, so
  // it is not judged for anchoring; and no FORM's ANY_ROOT matches its prefix. It
  // would simply pass — while at runtime it stays literal on Codex, and the consumer
  // then reads a path *named* `${CLAUDE_PLUGIN_ROOT}/x` relative to the workspace,
  // converting a fixed reference into a shadowable one.
  //
  // Naming the environment variable in prose is not a second spelling: the contract
  // in `commands/deep-review.md` legitimately says which variables to consult when
  // deriving the root. What is banned is spelling a PATH against one.
  const offenders = [];
  for (const file of markdownFiles()) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const spelling of ANCHOR_MISSPELLINGS) {
        if (spelling.test(line)) offenders.push(`${path.relative(ROOT, file)}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    'second anchor spelling — this plugin anchors on the derived '
    + `${ANCHOR_LITERAL} placeholder only:\n  ${offenders.join('\n  ')}`);
});

test('every referenced plugin path resolves inside the root', () => {
  const patterns = [
    // Trailing boundary, same reason as the guard: without it `.js` matches the
    // prefix of `.json` and the resolver reports files that never existed. `mjs`
    // and `cjs` precede `js` so the alternation reaches them.
    [/\{plugin_root\}[\\/]([A-Za-z0-9._\\/-]+\.(?:md|mjs|cjs|js|sh|json|yaml|yml)(?![A-Za-z0-9]))/g, false],
    [/`(\.\.[\\/][A-Za-z0-9._\\/-]+\.md)(?:#[a-z0-9-]+)?`/g, true],
    [/\]\((\.\.?[\\/][A-Za-z0-9._\\/-]+\.md)\)/g, true],
  ];

  // Either separator in every pattern. This resolver reads the raw body on purpose,
  // so normalizePath never reaches it and each pattern has to accept `\` itself.
  // Slash-only left the backslash spelling of an out-of-root reference visible to
  // the classifier but INVISIBLE here — the layer that actually checks containment.
  // A failure count hides exactly that, because the classifier keeps the total
  // non-zero; only naming the tests that fired shows which layer went quiet. One
  // sample per pattern, both spellings, because two of the three match nothing in
  // the current corpus and a real-file sweep gives them no coverage at all.
  const samples = [
    [`${ANCHOR_LITERAL}/../workspace/evil.json`,
      `${ANCHOR_LITERAL}\\..\\workspace\\evil.json`],
    ['`../references/x.md`', '`..\\references\\x.md`'],
    ['[l](../references/x.md)', '[l](..\\references\\x.md)'],
  ];
  patterns.forEach(([re], i) => {
    for (const spelling of samples[i]) {
      re.lastIndex = 0;
      assert.ok(re.exec(spelling), `pattern ${i} must see both spellings: ${spelling}`);
    }
  });

  const broken = [];
  let resolved = 0;
  const realRoot = fs.realpathSync(ROOT);
  for (const file of markdownFiles()) {
    const body = fs.readFileSync(file, 'utf8');
    for (const [re, isRelative] of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(body))) {
        // Normalising the capture is load-bearing but NOT pinned: removing it breaks
        // no test, because no shipped document uses the backslash spelling yet. The
        // failure would first appear as a false `missing` on a file that exists.
        // Recorded, not claimed.
        const target = isRelative
          ? path.resolve(path.dirname(file), normalizePath(m[1]))
          : path.join(ROOT, normalizePath(m[1]));
        if (!fs.existsSync(target)) {
          broken.push(`${path.relative(ROOT, file)} -> ${m[1]} (missing)`);
          continue;
        }
        // Existing is not enough: a target that resolves outside the plugin root —
        // lexically or through a symlinked component — is exactly the file an
        // attacker wants accepted. Containment is checked here too, so the two tests
        // cannot disagree about what counts as in-root.
        const real = fs.realpathSync(target);
        if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
          broken.push(`${path.relative(ROOT, file)} -> ${m[1]} (resolves outside the plugin root: ${real})`);
          continue;
        }
        resolved += 1;
      }
    }
  }
  assert.deepEqual(broken, [], `unresolvable or out-of-root reference:\n  ${broken.join('\n  ')}`);
  assert.ok(resolved > 0, 'sweep matched no references at all — the patterns have rotted');
});

test('the plugin file index and the tokens looked up in it use one spelling', () => {
  // Normalising the token but not the index normalises one side of a comparison,
  // which is not normalising at all. `path.relative` returns the host's separator,
  // so on Windows every PLUGIN_FILES key would read `hooks\scripts\envelope.js` while
  // every token looked up in it reads `hooks/scripts/envelope.js` — deny-by-default
  // would then resolve nothing at all, the guard would pass **while a violation is
  // present**, and silently green is the worst state a guard can be in.
  //
  // Windows is emulated here rather than assumed: path.win32.relative is the same
  // implementation that host runs, so this reproduces the mismatch from a POSIX
  // runner instead of waiting for a Windows user to find it.
  const wrongSpelling = [...PLUGIN_FILES].filter((k) => k.includes('\\'));
  assert.deepEqual(wrongSpelling, [],
    'PLUGIN_FILES keys must be canonicalised at construction, not left in the '
    + `host separator:\n  ${wrongSpelling.slice(0, 10).join('\n  ')}`);

  const winRel = path.win32.relative(
    'C:\\plugin-root', 'C:\\plugin-root\\hooks\\scripts\\envelope.js');
  assert.equal(winRel, 'hooks\\scripts\\envelope.js',
    'precondition — win32 relative must produce the backslash spelling');
  assert.equal(normalizePath(winRel), 'hooks/scripts/envelope.js');

  // The real index must contain the canonical form and not the host-shaped one. The
  // second assertion is what makes the first non-vacuous: it shows the two spellings
  // are genuinely different keys, so agreeing on one is load-bearing.
  assert.ok(PLUGIN_FILES.has(normalizePath(winRel)),
    'the canonical spelling must be a key in the index');
  assert.equal(PLUGIN_FILES.has(winRel), false,
    'the host-shaped spelling must not be — otherwise this test proves nothing');

  // The derivation itself, driven by the Windows implementation.
  assert.equal(
    repoKey('C:\\plugin-root', 'C:\\plugin-root\\hooks\\scripts\\envelope.js',
      path.win32.relative),
    'hooks/scripts/envelope.js',
    'repoKey must canonicalise whatever separator its host relative() returns');

  // End-to-end: rebuild the entire index the way a Windows host would spell it —
  // every real plugin file, re-rooted under a win32 path, run back through the same
  // derivation — and require the result to be identical. This is what makes the whole
  // axis provable from a POSIX runner: with the normalisation removed from repoKey,
  // every one of these keys comes back with backslashes.
  const winRoot = 'C:\\plugin-root';
  const rebuilt = new Set([...PLUGIN_FILES].map((key) =>
    repoKey(winRoot, path.win32.join(winRoot, ...key.split('/')), path.win32.relative)));
  assert.deepEqual([...rebuilt].sort(), [...PLUGIN_FILES].sort(),
    'the index a Windows host builds must be key-for-key identical to this one');
  assert.ok(rebuilt.size > 50,
    `emulation swept only ${rebuilt.size} keys — the index is too small to be real`);

  // Both call sites, driven behaviourally rather than pinned by source text. A
  // source-text assertion pins the spelling of a call; it cannot see the
  // normalisation being removed from inside the function that call names. The seams
  // make the real thing decidable: build the index the way a Windows host spells it,
  // then run the production lookup against it.
  const winKeys = buildPluginFiles({
    toKey: (p) => path.relative(ROOT, p).split(path.sep).join('\\'),
  });
  assert.ok(winKeys.has('hooks/scripts/envelope.js'),
    'key generation must normalise, not merely store what the platform produced');

  // Nested source on purpose: from a root-level document `dirname` is ROOT, so the
  // source-relative branch reproduces the direct branch and would rescue an
  // un-normalised token, hiding what these assertions claim to pin.
  const nested = path.join(ROOT, 'skills', 'deep-review-workflow', 'SKILL.md');
  assert.equal(resolvesInPlugin('hooks/scripts/envelope.js', nested, winKeys), true,
    'a slash-shaped lookup must resolve against Windows-shaped keys');
  assert.equal(resolvesInPlugin('hooks\\scripts\\envelope.js', nested, winKeys), true,
    'a backslash-shaped lookup must resolve too');

  // The `fromSource` half. On POSIX `path.relative` already returns slashes, so
  // removing repoKey's normalisation there is a no-op no local mutation can see —
  // driving the production call with a win32 `relative` is what makes it visible.
  const nestedTarget = [...winKeys].find((k) => k.includes('/'));
  const dir = nestedTarget.slice(0, nestedTarget.lastIndexOf('/'));
  const base = nestedTarget.slice(nestedTarget.lastIndexOf('/') + 1);
  const winRelative = (from, to) => path.relative(from, to).split('/').join('\\');
  // This pin is vacuous unless the DIRECT branch misses. `resolvesInPlugin` strips
  // the leading `./` and looks the bare basename up first; if a file of that name
  // sits at the repo root it returns there and the source-relative branch — the
  // thing being pinned — never runs, while the assertion still sees `true`.
  assert.equal(winKeys.has(base), false,
    `a root-level ${base} would make the next assertion vacuous`);
  assert.equal(
    resolvesInPlugin(`./${base}`, path.join(ROOT, dir, 'sibling.md'), winKeys, winRelative),
    true,
    'the source-relative branch must normalise its own result before looking it up');

  // Non-vacuity, with a backslash token on purpose. A slash token makes this pair
  // decorative — the un-normalised key set misses either way, so it passes however
  // the token was handled. The backslash spelling discriminates.
  //
  // It is *dominated* in the current arrangement: the backslash lookup above fails
  // first on the same mutation, so this line does not execute and adds no detection
  // today. It is kept as a backstop, because the assertion that dominates it is an
  // enumeration of spellings — and enumerations get trimmed.
  const rawKeys = new Set([...winKeys].map((k) => k.split('/').join('\\')));
  assert.equal(resolvesInPlugin('hooks\\scripts\\envelope.js', nested, rawKeys), false,
    'un-normalised keys must not be reachable by an un-normalised token');
});
