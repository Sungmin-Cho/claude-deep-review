#!/usr/bin/env node

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const mutationTest = 'tests/mutation-protocol.test.js';

export const mutationShardPatterns = Object.freeze({
  'groups-01-06': '^\\[group [1-6]\\]',
  'groups-07-12': '^\\[group (?:[7-9]|1[0-2])\\]',
  'groups-13-18': '^\\[group 1[3-8]\\]',
  'groups-19-23': '^\\[group (?:19|2[0-3])\\]',
  'r1-r2-core': '^\\[(?:R1C|R2 (?:C1|C2|W1|W2|W3))',
  'r2-c3': '^\\[R2 C3',
  'r3-core': '^\\[R3 (?:C1|C2|W1|W2)',
  'r3-c3-r4': '^\\[(?:R3 C3|R4)',
  'r5-r6': '^\\[(?:R5|R6)',
});

export const windowsNativeShardIds = Object.freeze([
  'non-mutation',
  ...Object.keys(mutationShardPatterns),
]);

export function nonMutationTestFiles(root = repositoryRoot) {
  return readdirSync(join(root, 'tests'))
    .filter((name) => name.endsWith('.test.js') && name !== 'mutation-protocol.test.js')
    .sort()
    .map((name) => 'tests/' + name);
}

export function testArgumentsForShard(shard, root = repositoryRoot) {
  if (shard === 'non-mutation') {
    return ['--test', ...nonMutationTestFiles(root)];
  }
  const pattern = mutationShardPatterns[shard];
  if (!pattern) throw new TypeError('unknown Windows native shard: ' + shard);
  return ['--test', '--test-name-pattern', pattern, mutationTest];
}

function main(argv) {
  const [shard] = argv;
  const args = testArgumentsForShard(shard);
  const result = spawnSync(process.execPath, args, {
    cwd: repositoryRoot,
    env: process.env,
    shell: false,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) {
    process.stderr.write('Windows native shard failed to start: ' + result.error.message + '\n');
    process.exitCode = result.error.code === 'ENOENT' ? 127 : 1;
    return;
  }
  process.exitCode = result.status ?? 1;
}

if (process.argv[1]
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 2;
  }
}
