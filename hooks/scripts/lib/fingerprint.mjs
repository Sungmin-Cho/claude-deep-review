import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

import { runProcess } from './process.mjs';
import { createSensitiveFileScanner } from './sensitive-files.mjs';
import { inspectProtocol } from '../mutation-protocol.mjs';

const MAX_WALK_ENTRIES = 200_000;
const MAX_WALK_DEPTH = 128;
const MAX_SYMLINKS = 40;
const MAX_RUNTIME_SYMLINK_TARGET_BYTES = 16_384;
const STANDARD_EXCLUDED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  'dist',
  'build',
  'target',
  '.next',
  '.svelte-kit',
  'coverage',
  'out',
  '.gradle',
  '.cargo',
  'vendor',
  '.terraform',
]);
const RUNTIME_STATE_PATHS = [
  '.deep-review/config.yaml',
  '.deep-review/.pending-mutation.json',
];
const V3_PUBLICATION_REF = 'refs/worktree/deep-review/mutation/v3/publication';
const V3_SLOT_PATHS = Object.freeze({
  a: '.deep-review/.pending-mutation.v3.a.json',
  b: '.deep-review/.pending-mutation.v3.b.json',
});
const V3_SIGNAL_PATHS = Object.freeze([
  V3_SLOT_PATHS.a,
  V3_SLOT_PATHS.b,
  '.deep-review/.mutation.operation.reserve',
  '.deep-review/.mutation.lock',
]);

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function pathBuffer(parent, name) {
  return Buffer.concat([parent, Buffer.from(sep), name]);
}

function slashBuffer(parts) {
  return Buffer.concat(parts.flatMap((part, index) => (
    index === 0 ? [part] : [Buffer.from('/'), part]
  )));
}

function displayPath(raw) {
  return raw.toString('utf8').replaceAll('\\', '/');
}

function shouldExcludeDirectory(parts, name, standardExclusions, excludeReviewReports) {
  const decoded = name.toString('utf8');
  const folded = decoded.toLowerCase();
  if (folded === '.git') return true;
  if (standardExclusions && STANDARD_EXCLUDED_DIRECTORIES.has(folded)) return true;
  if (
    excludeReviewReports
    && parts.length === 1
    && parts[0].toString('utf8').toLowerCase() === '.deep-review'
    && folded === 'reports'
  ) return true;
  return false;
}

export function walkRepositoryFiles(repo, options = {}) {
  const root = realpathSync(resolve(repo));
  const rootBuffer = Buffer.from(root);
  const standardExclusions = options.standardExclusions !== false;
  const excludeReviewReports = options.excludeReviewReports === true;
  const output = [];
  let count = 0;

  function visit(full, parts, depth) {
    if (depth > (options.maxDepth ?? MAX_WALK_DEPTH)) {
      throw new Error(`repository walk exceeded depth limit at ${displayPath(slashBuffer(parts))}`);
    }
    const entries = readdirSync(full, { withFileTypes: true, encoding: 'buffer' });
    for (const entry of entries) {
      count += 1;
      if (count > (options.maxEntries ?? MAX_WALK_ENTRIES)) {
        throw new Error('repository walk exceeded entry limit');
      }
      const name = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name);
      const nextParts = [...parts, name];
      const nextFull = pathBuffer(full, name);
      if (entry.isDirectory()) {
        if (!shouldExcludeDirectory(parts, name, standardExclusions, excludeReviewReports)) {
          visit(nextFull, nextParts, depth + 1);
        }
        continue;
      }
      if (entry.isFile() || entry.isSymbolicLink()) {
        output.push({
          full: nextFull,
          relative: slashBuffer(nextParts),
          display: displayPath(slashBuffer(nextParts)),
          type: entry.isSymbolicLink() ? 'symlink' : 'file',
        });
      }
    }
  }

  visit(rootBuffer, [], 0);
  output.sort((left, right) => Buffer.compare(left.relative, right.relative));
  return output;
}

function insideRepository(repo, candidate) {
  const rel = relative(repo, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function symlinkChainValue(kind, targets, tail) {
  const framedTargets = targets.flatMap((target) => [
    Buffer.from(String(target.length)),
    Buffer.from(':'),
    target,
    Buffer.from('\0'),
  ]);
  return Buffer.concat([
    Buffer.from(`${kind}\0`),
    ...framedTargets,
    ...(tail === undefined ? [] : [Buffer.from('\0'), Buffer.from(tail)]),
  ]);
}

function symlinkFingerprint(repo, entry) {
  const original = entry.full.toString();
  let current = original;
  const targets = [];
  try {
    for (let count = 0; count < MAX_SYMLINKS; count += 1) {
      const info = lstatSync(current);
      if (!info.isSymbolicLink()) {
        const canonical = realpathSync(current);
        if (!insideRepository(repo, canonical)) {
          return symlinkChainValue('symlink-outside', targets);
        }
        const targetInfo = statSync(canonical);
        if (!targetInfo.isFile() || targetInfo.size > MAX_RUNTIME_SYMLINK_TARGET_BYTES) {
          return symlinkChainValue('symlink-unbounded', targets);
        }
        return symlinkChainValue(
          'symlink-file',
          targets,
          Buffer.from(sha256(readFileSync(canonical))),
        );
      }
      const target = readlinkSync(current, { encoding: 'buffer' });
      targets.push(Buffer.from(target));
      const decoded = targets.at(-1).toString('utf8');
      current = isAbsolute(decoded) ? decoded : resolve(dirname(current), decoded);
    }
    return symlinkChainValue('symlink-cycle', targets);
  } catch (error) {
    return symlinkChainValue('symlink-error', targets, error.code || 'UNKNOWN');
  }
}

function entryValue(repo, entry) {
  if (entry.type === 'symlink') return symlinkFingerprint(repo, entry);
  return Buffer.from(`file\0${sha256(readFileSync(entry.full))}`);
}

function framedEntry(path, value) {
  return Buffer.concat([
    Buffer.from(String(path.length)),
    Buffer.from(':'),
    path,
    Buffer.from('\0'),
    Buffer.from(String(value.length)),
    Buffer.from(':'),
    value,
    Buffer.from('\n'),
  ]);
}

export function stableDigest(entries, domain = 'deep-review-fingerprint-v1') {
  const hash = createHash('sha256');
  hash.update(`${domain}\0`);
  for (const entry of [...entries].sort((a, b) => Buffer.compare(a.path, b.path))) {
    hash.update(framedEntry(entry.path, entry.value));
  }
  return hash.digest('hex');
}

function fullWalkEntries(repo) {
  return walkRepositoryFiles(repo, { standardExclusions: true }).map((entry) => ({
    path: entry.relative,
    value: entryValue(repo, entry),
  }));
}

function mutationAuthorityError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = 'MUTATION_AUTHORITY_INVALID';
  return error;
}

async function readV3AuthoritySnapshot(repo) {
  let inspection;
  try {
    inspection = inspectProtocol({ repo });
  } catch (cause) {
    throw mutationAuthorityError(`v3 mutation authority inspection failed: ${cause.message}`, cause);
  }
  if (!inspection || inspection.status !== 'ready') {
    throw mutationAuthorityError(
      `v3 mutation authority is not ready: ${inspection?.reason || 'unknown state'}`,
    );
  }
  let slotA;
  let slotB;
  try {
    slotA = readFileSync(join(repo, ...V3_SLOT_PATHS.a.split('/')));
    slotB = readFileSync(join(repo, ...V3_SLOT_PATHS.b.split('/')));
  } catch (cause) {
    throw mutationAuthorityError(`v3 mutation authority capture failed: ${cause.message}`, cause);
  }
  const publicationResult = await runProcess(
    'git',
    ['cat-file', 'blob', inspection.publication_oid],
    { cwd: repo, timeoutMs: 30_000 },
  );
  if (publicationResult.code !== 0) {
    throw mutationAuthorityError(
      `v3 mutation publication blob cannot be read: ${publicationResult.stderr.toString('utf8').trim()}`,
    );
  }
  return {
    slotA,
    slotB,
    publication: publicationResult.stdout,
    publicationOid: inspection.publication_oid,
    fenceInventory: Buffer.from([
      inspection.fence_inventory.sha256,
      inspection.fence_inventory.entries,
      inspection.fence_inventory.bytes,
    ].join('\0')),
  };
}

function sameV3Authority(left, right) {
  return left.publicationOid === right.publicationOid
    && left.slotA.equals(right.slotA)
    && left.slotB.equals(right.slotB)
    && left.publication.equals(right.publication)
    && left.fenceInventory.equals(right.fenceInventory);
}

function authorityPathExists(repo, relativePath) {
  try {
    lstatSync(join(repo, ...relativePath.split('/')));
    return true;
  } catch (cause) {
    if (cause.code === 'ENOENT') return false;
    throw mutationAuthorityError(
      `v3 mutation authority path cannot be inspected: ${relativePath}: ${cause.message}`,
      cause,
    );
  }
}

export async function v3AuthorityEntries(repo) {
  const signalOnDisk = V3_SIGNAL_PATHS.some((relativePath) => (
    authorityPathExists(repo, relativePath)
  ));
  const ref = await runProcess('git', ['rev-parse', '--verify', '--quiet', V3_PUBLICATION_REF], {
    cwd: repo,
    timeoutMs: 30_000,
  });
  if (!signalOnDisk && ref.code !== 0) return [];

  const first = await readV3AuthoritySnapshot(repo);
  const second = await readV3AuthoritySnapshot(repo);
  if (!sameV3Authority(first, second)) {
    throw mutationAuthorityError('v3 mutation authority changed during fingerprint capture');
  }
  if (ref.code === 0 && ref.stdout.toString('ascii').trim() !== second.publicationOid) {
    throw mutationAuthorityError('v3 mutation publication ref changed during fingerprint capture');
  }
  return [
    { path: Buffer.from('@MUTATION-V3/fence-inventory'), value: second.fenceInventory },
    { path: Buffer.from('@MUTATION-V3/publication-current'), value: second.publication },
    { path: Buffer.from('@MUTATION-V3/publication-ref'), value: Buffer.from(second.publicationOid, 'ascii') },
    { path: Buffer.from('@MUTATION-V3/slot-a'), value: second.slotA },
    { path: Buffer.from('@MUTATION-V3/slot-b'), value: second.slotB },
  ];
}

function gitPathBuffer(repo, rawPath) {
  const components = [];
  let start = 0;
  for (let index = 0; index <= rawPath.length; index += 1) {
    if (index === rawPath.length || rawPath[index] === 47) {
      components.push(rawPath.subarray(start, index));
      start = index + 1;
    }
  }
  return components.reduce((parent, name) => pathBuffer(parent, name), Buffer.from(repo));
}

function dirtyValue(repo, path) {
  const full = gitPathBuffer(repo, path);
  try {
    const info = lstatSync(full);
    if (info.isSymbolicLink()) {
      return symlinkFingerprint(repo, { full, relative: path, type: 'symlink' });
    }
    if (info.isFile()) return Buffer.from(`file\0${sha256(readFileSync(full))}`);
    return Buffer.from('other');
  } catch (error) {
    if (error.code === 'ENOENT') return Buffer.from('missing');
    throw error;
  }
}

async function gitSnapshotEntries(repo) {
  const [head, status] = await Promise.all([
    runProcess('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repo, timeoutMs: 30_000 }),
    runProcess('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: repo,
      timeoutMs: 30_000,
    }),
  ]);
  if (status.code !== 0) {
    throw new Error(`git status failed: ${status.stderr.toString('utf8').trim()}`);
  }
  const entries = [{
    path: Buffer.from('@HEAD'),
    value: head.code === 0 ? Buffer.from(head.stdout.toString('ascii').trim()) : Buffer.from('no-head'),
  }];
  const tokens = [];
  let start = 0;
  for (let index = 0; index < status.stdout.length; index += 1) {
    if (status.stdout[index] === 0) {
      tokens.push(status.stdout.subarray(start, index));
      start = index + 1;
    }
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const record = tokens[index];
    if (record.length < 4 || record[2] !== 32) throw new Error('malformed git status record');
    const code = record.subarray(0, 2);
    const path = record.subarray(3);
    entries.push({
      path: Buffer.concat([Buffer.from('@STATUS/'), path]),
      value: Buffer.concat([code, Buffer.from('\0'), dirtyValue(repo, path)]),
    });
    if (code.includes(82) || code.includes(67)) index += 1;
  }
  return entries;
}

function readSensitivePatternData(pluginRoot) {
  const file = join(pluginRoot, 'hooks', 'scripts', 'lib', 'sensitive-patterns.list');
  let data;
  try {
    data = readFileSync(file);
  } catch (cause) {
    const error = new Error(`canonical sensitive pattern data is unavailable: ${file}`, { cause });
    error.code = 'SENSITIVE_PATTERN_DATA_UNAVAILABLE';
    throw error;
  }
  if (data.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    const error = new Error('canonical sensitive pattern data has UTF-8 BOM');
    error.code = 'SENSITIVE_PATTERN_DATA_UNAVAILABLE';
    throw error;
  }
  return data;
}

function sensitiveAndRuntimeEntries(repo, pluginRoot) {
  const patternBytes = readSensitivePatternData(pluginRoot);
  const scanSensitiveFiles = createSensitiveFileScanner({
    readPatternData: () => patternBytes.toString('utf8'),
  });
  const walked = walkRepositoryFiles(repo, {
    standardExclusions: true,
    excludeReviewReports: true,
  });
  const sensitive = new Set(scanSensitiveFiles({
    pluginRoot,
    files: walked.map((entry) => entry.display),
  }));
  const output = [];
  for (const entry of walked) {
    if (!sensitive.has(entry.display) && !RUNTIME_STATE_PATHS.includes(entry.display)) continue;
    output.push({
      path: Buffer.concat([Buffer.from('@SENSITIVE/'), entry.relative]),
      value: entryValue(repo, entry),
    });
  }
  return output;
}

export async function captureFingerprint(options = {}) {
  const mode = options.mode ?? 'hybrid';
  if (!['hybrid', 'full-walk', 'git-status', 'off'].includes(mode)) {
    throw new TypeError('mode must be hybrid, full-walk, git-status, or off');
  }
  if (mode === 'off') return { mode, digest: null, entries: 0, error: null };
  try {
    const repo = realpathSync(resolve(options.repo));
    if (mode === 'full-walk') {
      const entries = [...fullWalkEntries(repo), ...await v3AuthorityEntries(repo)];
      return {
        mode,
        digest: stableDigest(entries, 'deep-review-full-walk-v1'),
        entries: entries.length,
        error: null,
      };
    }
    const gitEntries = await gitSnapshotEntries(repo);
    if (mode === 'git-status') {
      return {
        mode,
        digest: stableDigest(gitEntries, 'deep-review-git-status-v1'),
        entries: gitEntries.length,
        error: null,
      };
    }
    try {
      const entries = [
        ...gitEntries,
        ...sensitiveAndRuntimeEntries(repo, resolve(options.pluginRoot)),
        ...await v3AuthorityEntries(repo),
      ];
      return {
        mode,
        digest: stableDigest(entries, 'deep-review-hybrid-v1'),
        entries: entries.length,
        error: null,
      };
    } catch (error) {
      if (error.code !== 'SENSITIVE_PATTERN_DATA_UNAVAILABLE' && !/pattern data/iu.test(error.message)) {
        throw error;
      }
      const entries = [...fullWalkEntries(repo), ...await v3AuthorityEntries(repo)];
      return {
        mode: 'full-walk',
        degradedFrom: 'hybrid',
        digest: stableDigest(entries, 'deep-review-full-walk-v1'),
        entries: entries.length,
        error: null,
        warning: error.message,
      };
    }
  } catch (error) {
    return {
      mode,
      digest: null,
      entries: 0,
      error: `${error.code || error.name || 'ERROR'}: ${error.message}`,
    };
  }
}

export const __testing = Object.freeze({
  entryValue,
  displayPath,
  framedEntry,
  gitSnapshotEntries,
  v3AuthorityEntries,
});
