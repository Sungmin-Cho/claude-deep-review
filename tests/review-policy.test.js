'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const policyUrl = pathToFileURL(path.join(root, 'hooks/scripts/lib/review-policy.mjs')).href;

test('review policy parses nested maps/lists and preserves unknown fields with warnings', async () => {
  const { parseReviewPolicy } = await import(policyUrl);
  const result = parseReviewPolicy(`
schema_version: 2
features:
  semantic_classifier: true
routing:
  policy: quality
classification:
  overrides:
    - glob: "docs/**"
      kind: design-document
future_field:
  enabled: true
`);
  assert.equal(result.policy.features.semantic_classifier, true);
  assert.equal(result.policy.routing.policy, 'quality');
  assert.deepEqual(result.policy.classification.overrides, [{ glob: 'docs/**', kind: 'design-document' }]);
  assert.equal(result.policy.future_field.enabled, true);
  assert.ok(result.warnings.some((warning) => warning.includes('future_field')));
});

test('review policy rejects duplicate keys, aliases, anchors, tags, and wrong schema', async () => {
  const { parseReviewPolicy } = await import(policyUrl);
  assert.throws(() => parseReviewPolicy('schema_version: 2\nrouting:\n  policy: auto\n  policy: fast\n'), /duplicate/i);
  assert.throws(() => parseReviewPolicy('schema_version: 2\nx: &shared value\n'), /anchor|alias/i);
  assert.throws(() => parseReviewPolicy('schema_version: 2\nx: *shared\n'), /anchor|alias/i);
  assert.throws(() => parseReviewPolicy('schema_version: 2\nx: !thing value\n'), /tag/i);
  assert.throws(() => parseReviewPolicy('schema_version: 1\n'), /schema_version.*2/i);
});

test('loaders resolve project, XDG, and Windows APPDATA config locations', async () => {
  const { loadReviewPolicy, loadUserConfig, userConfigPath } = await import(policyUrl);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-policy-'));
  const projectDir = path.join(temp, '.deep-review');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'review-policy.yaml'), 'schema_version: 2\nrouting:\n  policy: fast\n');
  assert.equal(loadReviewPolicy(temp).policy.routing.policy, 'fast');
  assert.equal(loadReviewPolicy(path.join(temp, 'missing')), null);

  const xdg = path.join(temp, 'xdg');
  fs.mkdirSync(path.join(xdg, 'deep-review'), { recursive: true });
  fs.writeFileSync(path.join(xdg, 'deep-review', 'config.yaml'), 'schema_version: 2\nfeatures:\n  routing_shadow_mode: true\n');
  assert.equal(loadUserConfig({ XDG_CONFIG_HOME: xdg }).policy.features.routing_shadow_mode, true);
  assert.equal(userConfigPath({ APPDATA: 'C:\\Users\\Me\\AppData\\Roaming' }, 'win32'), path.win32.join('C:\\Users\\Me\\AppData\\Roaming', 'deep-review', 'config.yaml'));
});

// I2: classification.size_thresholds must be a known schema field (not just an
// unrecognized-but-preserved one) so review-policy.yaml can actually express
// the size thresholds that buildRoutingPlan already reads.
test('I2: classification.size_thresholds is a known schema field and surfaces its parsed value with no warning', async () => {
  const { parseReviewPolicy } = await import(policyUrl);
  const result = parseReviewPolicy(`
schema_version: 2
classification:
  size_thresholds:
    code: [50, 200, 800]
    document: [1024, 4096, 16384]
`);
  assert.deepEqual(result.policy.classification.size_thresholds.code, [50, 200, 800]);
  assert.deepEqual(result.policy.classification.size_thresholds.document, [1024, 4096, 16384]);
  assert.ok(
    !result.warnings.some((warning) => warning.includes('classification.size_thresholds')),
    'classification.size_thresholds must be a recognized field, not an unknown-field warning',
  );
});

test('merge precedence is defaults < user < project < CLI while project enforced deny wins', async () => {
  const { mergeRoutingConfig } = await import(policyUrl);
  const merged = mergeRoutingConfig({
    defaults: { routing: { policy: 'auto' }, constraints: { deny_models: ['base-deny'] } },
    user: { routing: { policy: 'fast' }, providers: { claude: { enabled: true } } },
    project: { routing: { policy: 'balanced' }, constraints: { deny_models: ['forbidden'], allowed_providers: ['claude'] } },
    cli: { routing_policy: 'quality', providers: { claude: { model: 'forbidden' } } },
  });
  assert.equal(merged.routing.policy, 'quality');
  assert.equal(merged.providers.claude.model, 'forbidden');
  assert.deepEqual(merged.constraints.deny_models, ['forbidden']);
  assert.deepEqual(merged.constraints.allowed_providers, ['claude']);
});
