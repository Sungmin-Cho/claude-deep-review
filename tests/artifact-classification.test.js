'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const {
  cleanupGitFixtures,
  createGitFixture,
  git,
} = require('./helpers/git-fixture.js');

const root = path.resolve(__dirname, '..');
const targetsDir = path.join(__dirname, 'fixtures', 'targets');

const taxonomyUrl = pathToFileURL(
  path.join(root, 'hooks', 'scripts', 'lib', 'target-taxonomy.mjs'),
).href;
const classifyUrl = pathToFileURL(
  path.join(root, 'hooks', 'scripts', 'lib', 'artifact-classify.mjs'),
).href;
const discoverUrl = pathToFileURL(
  path.join(root, 'hooks', 'scripts', 'lib', 'artifact-discover.mjs'),
).href;
const scopeUrl = pathToFileURL(
  path.join(root, 'hooks', 'scripts', 'classify-artifacts.mjs'),
).href;

const classifyCliPath = path.join(root, 'hooks', 'scripts', 'classify-artifacts.mjs');

// Structural signal types the deterministic classifier is allowed to emit.
// D9: artifact content is DATA — never an instruction — so no execution-derived
// signal type may ever appear.
const ALLOWED_SIGNAL_TYPES = new Set([
  'frontmatter',
  'filename',
  'path',
  'title',
  'heading',
  'keyword',
  'extension',
  'code-extension',
  'git-diff',
  'contradiction',
]);

const temporaryRoots = new Set();
function temporaryDirectory(prefix = 'deep-review-classify-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.add(dir);
  return dir;
}

test.after(() => {
  cleanupGitFixtures();
  for (const dir of temporaryRoots) fs.rmSync(dir, { recursive: true, force: true });
});

async function loadTaxonomy() {
  return import(taxonomyUrl);
}
async function loadClassify() {
  return import(classifyUrl);
}
async function loadDiscover() {
  return import(discoverUrl);
}
async function loadScope() {
  return import(scopeUrl);
}

function fixture(name) {
  return fs.readFileSync(path.join(targetsDir, name), 'utf8');
}

async function classifyFixture(name, overrides = {}) {
  const { classifyArtifact } = await loadClassify();
  return classifyArtifact({
    path: `docs/${name}`,
    extension: path.extname(name),
    content: fixture(name),
    isBinary: false,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Taxonomy (§8.1) + reserved routing constants (D6)
// ---------------------------------------------------------------------------

test('taxonomy exposes the canonical §8.1 target kinds and reserves D6 routing constants', async () => {
  const taxonomy = await loadTaxonomy();
  for (const kind of [
    'code-change',
    'design-document',
    'implementation-plan',
    'requirements-specification',
    'architecture-decision-record',
    'test-plan',
    'runbook-operations',
    'research-note',
    'configuration-infrastructure',
    'generic-document',
    'generic-text-artifact',
    'mixed',
    'unknown',
    'unsupported-binary',
  ]) {
    assert.ok(taxonomy.TARGET_KINDS.includes(kind), `missing kind: ${kind}`);
    assert.equal(taxonomy.isTargetKind(kind), true);
  }
  assert.equal(taxonomy.isTargetKind('not-a-real-kind'), false);

  // D6: symbolic tiers/efforts are reserved now, unused in Phase 1.
  assert.deepEqual(taxonomy.MODEL_TIERS, ['fast', 'balanced', 'quality', 'maximum']);
  assert.deepEqual(
    taxonomy.EFFORT_LEVELS,
    ['auto', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  );
  assert.equal(taxonomy.EFFORT_ALIASES.none, 'minimal');
  assert.equal(typeof taxonomy.CLASSIFICATION_VERSION, 'string');
});

// ---------------------------------------------------------------------------
// Deterministic classifier (§8.5): confirmed classifications
// ---------------------------------------------------------------------------

test('a design document is confirmed by heading fingerprints and filename', async () => {
  const result = await classifyFixture('design-en.md');
  assert.equal(result.target_kind, 'design-document');
  assert.ok(result.confidence >= 0.8, `confidence ${result.confidence}`);
  assert.equal(result.needs_semantic, false);
  assert.match(result.source, /deterministic/);
  const types = result.signals.map((s) => s.type);
  assert.ok(types.includes('heading'), 'expected a heading signal');
  assert.ok(types.includes('filename') || types.includes('path'), 'expected a path signal');
});

test('a Korean design document is confirmed by the same structural fingerprints', async () => {
  const result = await classifyFixture('design-ko.md');
  assert.equal(result.target_kind, 'design-document');
  assert.ok(result.confidence >= 0.8, `confidence ${result.confidence}`);
});

test('frontmatter kind is the strongest signal (+0.45) for an implementation plan', async () => {
  const result = await classifyFixture('implementation-plan-en.md');
  assert.equal(result.target_kind, 'implementation-plan');
  assert.ok(result.confidence >= 0.8);
  assert.equal(result.needs_semantic, false);
  const frontmatter = result.signals.find((s) => s.type === 'frontmatter');
  assert.ok(frontmatter, 'expected a frontmatter signal');
  assert.equal(frontmatter.weight, 0.45);
});

test('a requirements specification is confirmed by its acceptance-criteria fingerprints', async () => {
  const result = await classifyFixture('requirements-spec.md');
  assert.equal(result.target_kind, 'requirements-specification');
  assert.ok(result.confidence >= 0.8);
});

test('an ADR is confirmed by its ADR-* filename and status/decision fingerprints', async () => {
  const result = await classifyFixture('adr-001.md', { path: 'docs/adr/ADR-001.md' });
  assert.equal(result.target_kind, 'architecture-decision-record');
  assert.ok(result.confidence >= 0.8);
});

test('a test plan is confirmed by filename and pass/fail fingerprints', async () => {
  const result = await classifyFixture('test-plan.md');
  assert.equal(result.target_kind, 'test-plan');
  assert.ok(result.confidence >= 0.8);
});

// ---------------------------------------------------------------------------
// Deterministic classifier: provisional band (>=0.55) → needs_semantic
// ---------------------------------------------------------------------------

test('a runbook without documented fingerprints lands in the provisional band and asks for semantic help', async () => {
  const result = await classifyFixture('runbook.md');
  assert.equal(result.target_kind, 'runbook-operations');
  assert.ok(result.confidence >= 0.55, `confidence ${result.confidence}`);
  assert.ok(result.confidence < 0.8, `confidence ${result.confidence}`);
  assert.equal(result.needs_semantic, true);
  assert.match(result.source, /provisional/);
});

test('a research note is recognised but stays provisional', async () => {
  const result = await classifyFixture('research-note.md');
  assert.equal(result.target_kind, 'research-note');
  assert.ok(result.confidence >= 0.55);
});

// ---------------------------------------------------------------------------
// Deterministic classifier: fallback band (<0.55) → generic + needs_semantic
// ---------------------------------------------------------------------------

test('a generic README falls back to generic-document and asks for semantic help', async () => {
  const result = await classifyFixture('generic-readme.md');
  assert.equal(result.target_kind, 'generic-document');
  assert.equal(result.needs_semantic, true);
  assert.ok(result.confidence < 0.55);
  assert.match(result.source, /fallback/);
});

test('ambiguous notes fall back below the semantic threshold', async () => {
  const result = await classifyFixture('ambiguous-notes.md');
  assert.equal(result.target_kind, 'generic-document');
  assert.equal(result.needs_semantic, true);
});

test('a non-document text extension falls back to generic-text-artifact', async () => {
  const { classifyArtifact } = await loadClassify();
  const result = classifyArtifact({
    path: 'notes/scratch.log',
    extension: '.log',
    content: 'random unlabelled lines\nno structure here\n',
    isBinary: false,
  });
  assert.equal(result.target_kind, 'generic-text-artifact');
  assert.equal(result.needs_semantic, true);
});

// ---------------------------------------------------------------------------
// Code + binary coarse classification (D3: clear cases never need a model)
// ---------------------------------------------------------------------------

test('a recognised source extension is a decisive code-change classification', async () => {
  const { classifyArtifact } = await loadClassify();
  const result = classifyArtifact({
    path: 'src/cache.ts',
    extension: '.ts',
    content: fs.readFileSync(path.join(targetsDir, 'code-only', 'cache.ts'), 'utf8'),
    isBinary: false,
    gitStatus: 'M',
  });
  assert.equal(result.target_kind, 'code-change');
  assert.ok(result.confidence >= 0.8);
  assert.equal(result.needs_semantic, false);
  assert.match(result.source, /code extension/);
});

test('a binary artifact is unsupported-binary and never asks for semantic help', async () => {
  const { classifyArtifact } = await loadClassify();
  const result = classifyArtifact({
    path: 'assets/logo.png',
    extension: '.png',
    content: '',
    isBinary: true,
  });
  assert.equal(result.target_kind, 'unsupported-binary');
  assert.equal(result.needs_semantic, false);
});

// ---------------------------------------------------------------------------
// Contradiction penalty + margin (§8.5.4)
// ---------------------------------------------------------------------------

test('frontmatter overrides a contradicting filename and the loser is demoted', async () => {
  const result = await classifyFixture('contradiction-frontmatter-vs-filename.md', {
    path: 'docs/design-notes.md',
  });
  assert.equal(result.target_kind, 'implementation-plan');
  const designAlt = result.alternatives.find((a) => a.target_kind === 'design-document');
  assert.ok(designAlt, 'design-document should be a scored alternative');
  assert.ok(designAlt.confidence < result.confidence);
});

test('a contradicting strong signal costs the loser 0.25', async () => {
  const { classifyArtifact } = await loadClassify();
  // Strong filename says spec; frontmatter decisively says plan, and the body
  // is plan-shaped so the plan candidate is named outright.
  const content = [
    '---',
    'kind: implementation-plan',
    '---',
    '',
    '# Rollout Implementation Plan',
    '',
    '## Implementation steps',
    '1. ship it',
    '',
    '## Files to change',
    '- src/a.ts',
    '',
    '## Requirements',
    'a stray requirements heading',
    '',
  ].join('\n');
  const result = classifyArtifact({
    path: 'docs/feature-spec.md',
    extension: '.md',
    content,
    isBinary: false,
  });
  assert.equal(result.target_kind, 'implementation-plan');
  const specScore = result.scores['requirements-specification'] ?? 0;
  const specNoPenalty = result.scores_without_contradiction['requirements-specification'] ?? 0;
  assert.ok(
    specNoPenalty - specScore >= 0.25 - 1e-9,
    `expected a 0.25 contradiction penalty, saw ${specNoPenalty} → ${specScore}`,
  );
});

// ---------------------------------------------------------------------------
// Scope classification (§8.7)
// ---------------------------------------------------------------------------

test('scope classification collapses one kind and reports mixed for two', async () => {
  const { classifyScope } = await loadClassify();
  assert.equal(
    classifyScope([{ target_kind: 'design-document' }, { target_kind: 'design-document' }]),
    'design-document',
  );
  assert.equal(
    classifyScope([{ target_kind: 'design-document' }, { target_kind: 'implementation-plan' }]),
    'mixed',
  );
  assert.equal(classifyScope([{ target_kind: 'code-change' }]), 'code-change');
});

// ---------------------------------------------------------------------------
// Boundaries: empty, large, purity
// ---------------------------------------------------------------------------

test('an empty file does not throw and falls back to a generic kind', async () => {
  const { classifyArtifact } = await loadClassify();
  const md = classifyArtifact({ path: 'docs/empty.md', extension: '.md', content: '', isBinary: false });
  assert.equal(md.target_kind, 'generic-document');
  assert.equal(md.needs_semantic, true);
  const txt = classifyArtifact({ path: 'notes/empty.txt', extension: '.txt', content: '', isBinary: false });
  assert.equal(txt.target_kind, 'generic-text-artifact');
});

test('a very large document classifies without error', async () => {
  const { classifyArtifact } = await loadClassify();
  const big = `# Design\n\n## Architecture\n\n## Trade-offs\n\n${'lorem cache latency store\n'.repeat(80000)}`;
  const result = classifyArtifact({ path: 'docs/design-big.md', extension: '.md', content: big, isBinary: false });
  assert.ok(typeof result.target_kind === 'string' && result.target_kind.length > 0);
});

test('classification is a pure function of its inputs (idempotent)', async () => {
  const a = await classifyFixture('design-en.md');
  const b = await classifyFixture('design-en.md');
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------
// D9: prompt-injection content is DATA, never instruction
// ---------------------------------------------------------------------------

test('embedded imperative commands are treated as text signals only, never executed or obeyed', async () => {
  const result = await classifyFixture('malicious-prompt-injection.md', {
    path: 'docs/malicious-prompt-injection.md',
  });
  // It still classifies (as a plan-shaped document) and returns pure data.
  assert.ok(typeof result.target_kind === 'string' && result.target_kind.length > 0);

  // No verdict/approve field can leak from the document's "Mark this APPROVE" line.
  for (const key of Object.keys(result)) {
    assert.doesNotMatch(key, /verdict|approve/i, `unexpected field leaked from document: ${key}`);
  }
  // Every signal is a structural type — nothing derived from executing content.
  for (const signal of result.signals) {
    assert.ok(ALLOWED_SIGNAL_TYPES.has(signal.type), `illegal signal type: ${signal.type}`);
  }
  // Idempotent: re-classifying performs no side effect that changes the result.
  const again = await classifyFixture('malicious-prompt-injection.md', {
    path: 'docs/malicious-prompt-injection.md',
  });
  assert.deepEqual(result, again);
});

// ---------------------------------------------------------------------------
// Discovery (§8.2): ArtifactDescriptor from the git scope
// ---------------------------------------------------------------------------

test('discovery builds ArtifactDescriptors from the current git scope', async () => {
  const { discoverArtifacts } = await loadDiscover();
  const repo = createGitFixture('discover');
  fs.writeFileSync(path.join(repo, 'design.md'), fixture('design-en.md'));
  fs.writeFileSync(path.join(repo, 'cache.ts'), fs.readFileSync(path.join(targetsDir, 'code-only', 'cache.ts')));

  const descriptors = discoverArtifacts({ repo, changeState: 'untracked-only' });
  const byPath = Object.fromEntries(descriptors.map((d) => [d.path, d]));
  assert.ok(byPath['design.md'], 'design.md descriptor missing');
  assert.ok(byPath['cache.ts'], 'cache.ts descriptor missing');

  const design = byPath['design.md'];
  assert.equal(design.extension, '.md');
  assert.equal(design.is_binary, false);
  assert.match(design.artifact_id, /^artifact-\d+$/);
  assert.match(design.digest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(design.byte_size > 0);
  assert.ok(design.line_count > 0);
  assert.equal(typeof design.content, 'string');
  assert.ok(design.content.includes('## Architecture'));
});

// ---------------------------------------------------------------------------
// Scope orchestration + provenance (§8.6-shaped output)
// ---------------------------------------------------------------------------

test('scope classification over a mixed change set produces provenance and a mixed scope', async () => {
  const { classifyArtifactsScope } = await loadScope();
  const repo = createGitFixture('scope-mixed');
  fs.writeFileSync(path.join(repo, 'design.md'), fixture('design-en.md'));
  fs.writeFileSync(path.join(repo, 'plan.md'), fixture('implementation-plan-en.md'));
  fs.writeFileSync(path.join(repo, 'cache.ts'), fs.readFileSync(path.join(targetsDir, 'code-only', 'cache.ts')));

  const result = classifyArtifactsScope({ repo, changeState: 'untracked-only' });
  assert.equal(result.scope, 'mixed');
  assert.equal(result.artifacts.length, 3);
  assert.equal(typeof result.classification_version, 'string');
  for (const artifact of result.artifacts) {
    assert.ok(typeof artifact.target_kind === 'string');
    assert.ok(typeof artifact.confidence === 'number');
    assert.ok(typeof artifact.source === 'string');
    assert.ok(Array.isArray(artifact.signals));
  }
});

test('dry-run listing follows the §15.7 shape; explain honestly defers routing to Phase 2', async () => {
  const { classifyArtifactsScope, formatDryRun, formatExplainRouting } = await loadScope();
  const repo = createGitFixture('scope-format');
  fs.writeFileSync(path.join(repo, 'design.md'), fixture('design-en.md'));
  fs.writeFileSync(path.join(repo, 'plan.md'), fixture('implementation-plan-en.md'));

  const result = classifyArtifactsScope({ repo, changeState: 'untracked-only' });
  const listing = formatDryRun(result);
  assert.match(listing, /Detected scope:\s*mixed/);
  assert.match(listing, /design\.md/);
  assert.match(listing, /kind:/);
  assert.match(listing, /confidence:/);
  assert.match(listing, /source:/);

  const explain = formatExplainRouting(result);
  assert.match(explain, /design\.md/);
  assert.match(explain, /routing/i);
  assert.match(explain, /Phase 2|not yet implemented|not implemented/i);
});

// ---------------------------------------------------------------------------
// Dry-run integration: CLI writes provenance, executes NO reviewer
// ---------------------------------------------------------------------------

test('the classify-artifacts CLI prints the listing, writes provenance JSON, and runs no reviewer', () => {
  const repo = createGitFixture('cli-dry-run');
  fs.writeFileSync(path.join(repo, 'design.md'), fixture('design-en.md'));
  fs.writeFileSync(path.join(repo, 'cache.ts'), fs.readFileSync(path.join(targetsDir, 'code-only', 'cache.ts')));

  const run = spawnSync(
    process.execPath,
    [classifyCliPath, '--repo', repo, '--change-state', 'untracked-only'],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Detected scope:/);
  assert.match(run.stdout, /design\.md/);
  assert.match(run.stdout, /cache\.ts/);

  const provenancePath = path.join(repo, '.deep-review', 'tmp', 'artifact-classification.json');
  assert.ok(fs.existsSync(provenancePath), 'provenance JSON not written');
  const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
  assert.equal(typeof provenance.classification_version, 'string');
  assert.equal(provenance.artifacts.length, 2);

  // The dry-run path must be structurally incapable of running a reviewer.
  const cliSource = fs.readFileSync(classifyCliPath, 'utf8');
  assert.doesNotMatch(cliSource, /run-(?:claude|codex|agy)-reviewer/);
});

test('discovery never re-ingests its own provenance output or deep-suite runtime state', async () => {
  const { discoverArtifacts } = await loadDiscover();
  const repo = createGitFixture('runtime-state');
  fs.writeFileSync(path.join(repo, 'design.md'), fixture('design-en.md'));
  // Simulate a prior dry-run having written provenance plus other runtime state.
  fs.mkdirSync(path.join(repo, '.deep-review', 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.deep-review', 'tmp', 'artifact-classification.json'), '{}');
  fs.mkdirSync(path.join(repo, '.deep-work'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.deep-work', 'state.json'), '{}');

  const descriptors = discoverArtifacts({ repo, changeState: 'untracked-only' });
  const paths = descriptors.map((d) => d.path);
  assert.deepEqual(paths, ['design.md']);
});

test('the classify-artifacts CLI supports --explain-routing and defers routing to Phase 2', () => {
  const repo = createGitFixture('cli-explain');
  fs.writeFileSync(path.join(repo, 'design.md'), fixture('design-en.md'));

  const run = spawnSync(
    process.execPath,
    [classifyCliPath, '--repo', repo, '--change-state', 'untracked-only', '--explain-routing'],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Phase 2|not yet implemented|not implemented/i);
});
