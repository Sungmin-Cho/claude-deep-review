'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const pluginRoot = resolve(__dirname, '..');
const configPath = join(pluginRoot, 'hooks', 'scripts', 'lib', 'config.mjs');
const configUrl = pathToFileURL(configPath).href;
const contractPath = join(pluginRoot, 'hooks', 'scripts', 'validate-contract.mjs');
const contractUrl = pathToFileURL(contractPath).href;
const currentFixture = join(__dirname, 'fixtures', 'sprint-contract-current.yaml');
const temporaryRoots = new Set();

function temporaryDirectory(prefix = 'deep-review-config-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.add(root);
  return root;
}

test.after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

async function loadConfig() {
  return import(configUrl);
}

async function loadContract() {
  return import(contractUrl);
}

function writeTemporaryFile(name, content) {
  const root = temporaryDirectory();
  const file = join(root, name);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
  return file;
}

test('top-level config supports unquoted, quoted, empty, boolean, and null scalars', async () => {
  const { readTopLevelConfig } = await loadConfig();
  const file = writeTemporaryFile('config.yaml', [
    '# user config',
    'review_model: fable',
    'quoted: "value: # data" # comment',
    'empty:',
    'enabled: true',
    'disabled: false',
    'last_review: null',
    'app_qa:',
    '  last_command: null',
    '',
  ].join('\n'));

  assert.deepEqual(readTopLevelConfig(file), {
    review_model: 'fable',
    quoted: 'value: # data',
    empty: '',
    enabled: true,
    disabled: false,
    last_review: null,
    app_qa: '',
  });
});

test('config patch changes exact value spans and inserts missing keys before last_review', async () => {
  const { patchTopLevelConfig } = await loadConfig();
  const file = writeTemporaryFile('config.yaml', [
    '# keep header',
    'review_model: fable # opaque model',
    'unknown_key: keep-me',
    'agy_sensitive_acked_fingerprint: "" # prior value',
    'last_review: null',
    'app_qa:',
    '  last_command: null',
    '',
  ].join('\r\n'));

  patchTopLevelConfig(file, {
    agy_sensitive_acked_fingerprint: 'abc123',
    agy_sensitive_acked_at: '2026-07-10T12:00:00Z',
  });

  assert.equal(readFileSync(file, 'utf8'), [
    '# keep header',
    'review_model: fable # opaque model',
    'unknown_key: keep-me',
    'agy_sensitive_acked_fingerprint: "abc123" # prior value',
    'agy_sensitive_acked_at: "2026-07-10T12:00:00Z"',
    'last_review: null',
    'app_qa:',
    '  last_command: null',
    '',
  ].join('\r\n'));
});

test('missing last_review appends new keys after the final top-level data key deterministically', async () => {
  const { patchTopLevelConfig, readTopLevelConfig } = await loadConfig();
  const file = writeTemporaryFile('fresh.yaml', [
    '# fresh config',
    'review_model: fable',
    'agy_enabled: false',
    '# trailing user note',
    '',
  ].join('\n'));

  patchTopLevelConfig(file, { agy_sensitive_acked_fingerprint: 'first' });
  patchTopLevelConfig(file, { agy_sensitive_acked_at: 'later' });

  assert.equal(readFileSync(file, 'utf8'), [
    '# fresh config',
    'review_model: fable',
    'agy_enabled: false',
    'agy_sensitive_acked_fingerprint: "first"',
    'agy_sensitive_acked_at: "later"',
    '# trailing user note',
    '',
  ].join('\n'));
  assert.equal(readTopLevelConfig(file).review_model, 'fable');
});

test('duplicate top-level config keys are rejected for reads and patches', async () => {
  const { patchTopLevelConfig, readTopLevelConfig } = await loadConfig();
  const file = writeTemporaryFile('duplicate.yaml', 'review_model: opus\nreview_model: fable\n');
  assert.throws(() => readTopLevelConfig(file), /duplicate.*review_model.*line 2/i);
  assert.throws(() => patchTopLevelConfig(file, { review_model: 'opus' }), /duplicate.*line 2/i);
  assert.equal(readFileSync(file, 'utf8'), 'review_model: opus\nreview_model: fable\n');
});

test('current Sprint Contract fixture preserves all shipped fields and prerequisites', async () => {
  const { parseSprintContract } = await loadContract();
  const parsed = parseSprintContract(readFileSync(currentFixture, 'utf8'));
  assert.deepEqual(parsed, {
    slice: 'SLICE-042',
    title: 'Cross-runtime contract: Windows #1',
    source_plan: 'plans/review.md#slice-042',
    created_at: '2026-07-10T12:34:56Z',
    status: 'active',
    criteria: [
      {
        id: 'C1',
        description: 'Preserve quoted colons: and # characters',
        verification: 'mixed',
        prerequisites: ['authenticated user: admin #1', 'feature-flag-review'],
        status: 'PARTIAL',
        evidence: 'Windows and POSIX receipts',
      },
      {
        id: 'C2',
        description: 'Run without shell helpers',
        verification: 'auto',
        prerequisites: [],
        status: null,
        evidence: null,
      },
    ],
  });
});

test('valid additive scalar and sequence fields are omitted without changing known values', async () => {
  const { parseSprintContract } = await loadContract();
  const source = [
    'slice: SLICE-007',
    'title: "Quoted: title # stays"',
    'source_plan: "plan.md#slice-007"',
    'created_at: "2026-07-10T00:00:00Z"',
    'owner: platform',
    'labels:',
    '  - windows',
    '  - "colon: # data"',
    'criteria:',
    '  - id: C1',
    '    description: "Value: # literal"',
    '    verification: manual',
    '    prerequisites:',
    '      - "auth: admin #1"',
    '    notes:',
    '      - additive',
    '    weight: high',
  ].join('\n');
  const parsed = parseSprintContract(source);
  assert.deepEqual(parsed, {
    slice: 'SLICE-007',
    title: 'Quoted: title # stays',
    source_plan: 'plan.md#slice-007',
    created_at: '2026-07-10T00:00:00Z',
    status: null,
    criteria: [{
      id: 'C1',
      description: 'Value: # literal',
      verification: 'manual',
      prerequisites: ['auth: admin #1'],
      status: null,
      evidence: null,
    }],
  });
});

test('unsupported or malformed YAML always fails deterministically with a 1-based line', async () => {
  const { parseSprintContract } = await loadContract();
  const base = [
    'slice: SLICE-001',
    'title: "Title"',
    'source_plan: "plan.md#slice-001"',
    'created_at: "2026-07-10T00:00:00Z"',
    'criteria:',
    '  - id: C1',
    '    description: "Criterion"',
    '    verification: auto',
    '    prerequisites: []',
  ];
  const cases = new Map([
    ['duplicate key', [...base.slice(0, 1), 'slice: SLICE-002', ...base.slice(1)]],
    ['duplicate criterion key', [...base, '    id: C2']],
    ['tab indentation', [...base.slice(0, 6), '\t description: bad', ...base.slice(7)]],
    ['anchor', [...base.slice(0, 1), 'title: &name "Title"', ...base.slice(2)]],
    ['alias', [...base.slice(0, 1), 'title: *name', ...base.slice(2)]],
    ['tag', [...base.slice(0, 1), 'title: !unsafe value', ...base.slice(2)]],
    ['merge key', [...base, '    <<: *defaults']],
    ['block scalar', [...base.slice(0, 1), 'title: |', '  multiline', ...base.slice(2)]],
    ['block scalar indicators', [...base.slice(0, 1), 'title: |2-', '  multiline', ...base.slice(2)]],
    ['malformed indentation', [...base.slice(0, 6), '   description: bad', ...base.slice(7)]],
    ['non-object criterion', [...base.slice(0, 5), '  - scalar']],
    ['missing required field', base.filter((line) => !line.startsWith('source_plan:'))],
    ['malformed prerequisites', base.map((line) => (
      line === '    prerequisites: []' ? '    prerequisites: auth' : line
    ))],
    ['invalid verification', base.map((line) => (
      line === '    verification: auto' ? '    verification: sometimes' : line
    ))],
  ]);

  for (const [name, lines] of cases) {
    assert.throws(
      () => parseSprintContract(lines.join('\n')),
      (error) => error instanceof Error && /line [1-9][0-9]*/i.test(error.message),
      name,
    );
  }
});

test('every block-scalar indicator is rejected at its declaration line', async () => {
  const { parseSprintContract } = await loadContract();
  for (const indicator of ['|', '>-', '|2-', '>+2']) {
    assert.throws(
      () => parseSprintContract([
        'slice: SLICE-001',
        `title: ${indicator}`,
        'source_plan: plan.md#slice-001',
        'created_at: 2026-07-10T00:00:00Z',
        'criteria: []',
      ].join('\n')),
      /block scalars are unsupported at line 2/i,
      indicator,
    );
  }
});

test('contract CLI emits one JSON result for success or safe skip without Python fallback', async () => {
  const valid = spawnSync(process.execPath, [contractPath, '--file', currentFixture], {
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.stderr, '');
  assert.equal(valid.stdout.trim().split('\n').length, 1);
  const accepted = JSON.parse(valid.stdout);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.data.source_plan, 'plans/review.md#slice-042');

  const invalidPath = writeTemporaryFile('invalid.yaml', 'slice: x\ntitle: *alias\ncriteria: []\n');
  const invalid = spawnSync(process.execPath, [contractPath, '--file', invalidPath], {
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(invalid.status, 0, invalid.stderr);
  assert.equal(invalid.stderr, '');
  const rejected = JSON.parse(invalid.stdout);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /line 2/i);
  assert.doesNotMatch(invalid.stdout, /pyyaml|python|fallback/i);
});
