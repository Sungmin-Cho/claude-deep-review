'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const routeUrl = pathToFileURL(path.join(root, 'hooks/scripts/public-route.mjs')).href;
const classifyUrl = pathToFileURL(path.join(root, 'hooks/scripts/classify-artifacts.mjs')).href;

test('review routing flags normalize repeated provider and canonical reviewer overrides', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const result = parsePublicRoute({
    entry: 'review', host: 'claude', cwd: root,
    argv: [
      '--routing', 'quality', '--model', 'claude=vendor=model=v2', '--effort', 'claude=high',
      '--model', 'agy=agy-pro', '--reviewer-model', 'claude-opus=best',
      '--reviewer-effort', 'codex-review=xhigh', '--reviewer-effort', 'codex-adversarial=max',
      '--reviewer-model', 'agy=agy-fast', '--allow-fallback', '--allow-classifier',
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.overrides, {
    protocol_version: '2.0',
    routing_policy: 'quality',
    allow_fallback: true,
    allow_classifier: true,
    providers: {
      claude: { model: 'vendor=model=v2', effort: 'high' },
      agy: { model: 'agy-pro' },
    },
    reviewers: {
      'claude-opus': { model: 'best' },
      'codex-review': { effort: 'xhigh' },
      'codex-adversarial': { effort: 'max' },
      agy: { model: 'agy-fast' },
    },
  });
});

test('routing flags reject duplicates, unknown keys, and codex-only conflicts', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const parse = (argv) => parsePublicRoute({ entry: 'review', host: 'claude', cwd: root, argv });
  assert.match(parse(['--model', 'claude=a', '--model', 'claude=b']).error, /duplicate/i);
  assert.match(parse(['--model', 'other=a']).error, /unknown provider/i);
  assert.match(parse(['--reviewer-model', 'claude-unknown=a']).error, /unknown reviewer/i);
  assert.match(parse(['--reviewer-model', 'claude-adversarial=a']).error, /unknown reviewer/i);
  assert.match(parse(['--codex-only', '--model', 'claude=a']).error, /ERROR_CONFLICTING_REVIEWER_SELECTION/);
  assert.equal(parse(['--routing', 'turbo']).ok, false);
});

test('loop grammar continues to reject all new review routing flags', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  for (const argv of [['--routing', 'auto'], ['--model', 'claude=x'], ['--allow-fallback'], ['--allow-classifier']]) {
    assert.equal(parsePublicRoute({ entry: 'loop', host: 'codex', argv }).ok, false);
  }
});

test('classify CLI override parser round-trips normalized schema and rejects malformed input', async () => {
  const { parseArguments } = await import(classifyUrl);
  const overrides = {
    protocol_version: '2.0', routing_policy: 'auto', allow_fallback: false,
    allow_classifier: false, providers: {}, reviewers: {},
  };
  assert.deepEqual(parseArguments(['--overrides-json', JSON.stringify(overrides)]).overrides, overrides);
  assert.throws(() => parseArguments(['--overrides-json', '{']), /overrides-json.*JSON/i);
  assert.throws(() => parseArguments(['--overrides-json', '{}']), /protocol_version/i);
});

test('public skill forwards normalized routing overrides as one compact JSON argv value', () => {
  const skill = fs.readFileSync(path.join(root, 'skills/deep-review/SKILL.md'), 'utf8');
  assert.match(skill, /--overrides-json/);
  assert.match(skill, /JSON\.stringify\(route\.overrides\)/);
  assert.match(skill, /single argv\s+value|single argument/i);
});
