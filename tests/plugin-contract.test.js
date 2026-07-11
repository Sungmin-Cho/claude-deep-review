'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

test('Codex manifest uses default hook discovery and registers no MCP server', () => {
  const manifest = JSON.parse(readFileSync('.codex-plugin/plugin.json', 'utf8'));
  assert.equal(Object.hasOwn(manifest, 'hooks'), false);
  assert.equal(Object.hasOwn(manifest, 'mcpServers'), false);
  assert.deepEqual(JSON.parse(readFileSync('hooks/hooks.json', 'utf8')).hooks, {});
});

test('package contract uses Node 22 and keeps Bash out of npm test', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.deepEqual(manifest.engines, { node: '>=22' });
  assert.equal(manifest.scripts.test, 'node --test');
  assert.equal(manifest.scripts['test:legacy'], 'bash scripts/run-all-tests.sh');
});
