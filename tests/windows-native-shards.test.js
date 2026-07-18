import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  mutationShardPatterns,
  nonMutationTestFiles,
  testArgumentsForShard,
  windowsNativeShardIds,
} from '../scripts/run-windows-native-shard.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('Windows native shards cover every test exactly once and preserve the required check', () => {
  const mutationSource = readFileSync(join(root, 'tests', 'mutation-protocol.test.js'), 'utf8');
  const names = [...mutationSource.matchAll(/^test\('([^']+)'/gmu)].map((match) => match[1]);
  assert.equal(names.length > 0, true);

  const patterns = Object.values(mutationShardPatterns).map((pattern) => new RegExp(pattern, 'u'));
  for (const name of names) {
    assert.equal(
      patterns.filter((pattern) => pattern.test(name)).length,
      1,
      name,
    );
  }

  const nonMutation = nonMutationTestFiles(root);
  assert.equal(nonMutation.includes('tests/mutation-protocol.test.js'), false);
  assert.equal(nonMutation.includes('tests/windows-native-shards.test.js'), true);

  const workflow = readFileSync(join(root, '.github', 'workflows', 'tests.yml'), 'utf8');
  for (const shard of windowsNativeShardIds) {
    const escaped = shard.replace(/[.*+?^$()|[\]\\]/gu, '\\$&');
    assert.match(workflow, new RegExp('- ' + escaped + '(?:\\r?\\n|$)', 'u'));
    assert.equal(testArgumentsForShard(shard, root)[0], '--test');
  }
  assert.match(workflow, /name:\s*native tests \(windows-latest\)/u);
  assert.match(workflow, /needs:\s*windows-test-shards/u);
  assert.match(workflow, /node scripts\/run-windows-native-shard\.mjs/u);
});
