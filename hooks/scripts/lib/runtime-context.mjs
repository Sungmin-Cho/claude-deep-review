import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename, dirname, isAbsolute, join, relative, resolve, sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

export function detectRuntimeHost(env = process.env) {
  if (env.CODEX_HOME || env.CODEX_THREAD_ID) return 'codex';
  if (env.CLAUDE_CODE || env.CLAUDE_PLUGIN_ROOT) return 'claude';
  return 'unknown';
}

export function resolvePluginRoot({ env = process.env, moduleUrl = import.meta.url } = {}) {
  const configured = env.PLUGIN_ROOT || env.CLAUDE_PLUGIN_ROOT;
  return resolve(configured || fileURLToPath(new URL('../../..', moduleUrl)));
}

function atomicWriteFileGuarded(filePath, data, options = {}, guard = null) {
  const normalized = typeof options === 'string' ? { encoding: options } : options;
  const destination = resolve(filePath);
  const parent = dirname(destination);
  const mode = normalized.mode ?? 0o600;
  const temporary = join(parent, `.${basename(destination)}.${randomUUID()}.tmp`);
  let descriptor;

  mkdirSync(parent, { recursive: true });
  try {
    guard?.beforeTempOpen();
    descriptor = openSync(temporary, 'wx', mode);
    writeFileSync(descriptor, data, normalized.encoding ? { encoding: normalized.encoding } : undefined);
    fsyncSync(descriptor);
    fchmodSync(descriptor, mode);
    closeSync(descriptor);
    descriptor = undefined;
    guard?.beforeRename();
    renameSync(temporary, destination);
    guard?.afterRename();
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original write error.
      }
    }
    try {
      guard?.beforeCleanup();
      rmSync(temporary, { force: true });
    } catch {
      // If the guarded parent changed identity, path-based cleanup could
      // itself cross the containment boundary. Leave the private temp entry
      // in the displaced validated directory instead.
    }
    throw error;
  }
}

export function atomicWriteFile(filePath, data, options = {}) {
  atomicWriteFileGuarded(filePath, data, options);
}

// True when `candidate` is `root` itself or lives beneath it. Both paths must
// already be real (symlink-resolved) so a symlinked parent directory that
// escapes the tree is rejected by the caller. Mirrors the discipline in
// lib/artifact-discover.mjs's isContained (read side) for the write side.
function isContained(root, candidate) {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function statType(stat) {
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'file';
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isBlockDevice()) return 'block-device';
  if (stat.isCharacterDevice()) return 'character-device';
  if (stat.isFIFO()) return 'fifo';
  if (stat.isSocket()) return 'socket';
  return 'other';
}

function directoryIdentity(pathname, missingAllowed = false) {
  let stat;
  try {
    stat = lstatSync(pathname, { bigint: true });
  } catch (error) {
    if (missingAllowed && error?.code === 'ENOENT') return null;
    throw error;
  }
  const type = statType(stat);
  if (type === 'symlink') {
    throw new Error(`refusing to write through symlinked path component: ${pathname}`);
  }
  if (type !== 'directory') {
    throw new Error(`refusing to write through a non-directory path component: ${pathname}`);
  }
  return { path: pathname, dev: stat.dev, ino: stat.ino, type };
}

function captureDirectoryChain(root, parent, missingAllowed) {
  const rel = relative(root, parent);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`refusing to write outside the repository root: ${parent}`);
  }
  const identities = [directoryIdentity(root)];
  let current = root;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = join(current, segment);
    const identity = directoryIdentity(current, missingAllowed);
    if (identity === null) break;
    identities.push(identity);
  }
  return identities;
}

function assertDirectoryIdentities(identities) {
  for (const expected of identities) {
    let actual;
    try {
      actual = directoryIdentity(expected.path);
    } catch {
      throw new Error(`path component changed during contained write: ${expected.path}`);
    }
    if (
      actual.dev !== expected.dev
      || actual.ino !== expected.ino
      || actual.type !== expected.type
    ) {
      throw new Error(`path component changed during contained write: ${expected.path}`);
    }
  }
}

const containedWriteSessions = new WeakMap();

/**
 * Resolve and validate a repository-contained destination without creating
 * directories or publishing data.
 */
function prepareContainedFilePath(repoRoot, destPath) {
  const repoRootResolved = resolve(repoRoot);
  let repoRealRoot;
  try {
    repoRealRoot = realpathSync(repoRootResolved);
  } catch {
    throw new Error(`repository containment root is unreadable: ${repoRootResolved}`);
  }
  const destination = resolve(destPath);

  // Lexical containment first: the destination must fall under repoRoot
  // itself, before any symlink resolution is even attempted.
  const relFromRoot = relative(repoRootResolved, destination);
  if (relFromRoot === '' || relFromRoot.startsWith('..') || isAbsolute(relFromRoot)) {
    throw new Error(`refusing to write outside the repository root: ${destination}`);
  }

  // (2) Walk every ancestor directory component from the repo root down to
  // the destination's parent. Any component that EXISTS and is a symlink is
  // refused outright — a symlinked intermediate directory would otherwise let
  // ordinary path resolution silently carry the write through it to an
  // arbitrary target. A component that does not exist yet ends the walk:
  // everything below it will be freshly created by mkdirSync below.
  const segments = relFromRoot.split(sep).filter(Boolean);
  const canonicalDestination = join(repoRealRoot, ...segments);
  const canonicalParent = dirname(canonicalDestination);
  const existingIdentities = captureDirectoryChain(repoRealRoot, canonicalParent, true);

  // (4) The destination itself, if it already exists, must not be a symlink.
  // atomicWriteFile's rename replaces the link entry itself rather than
  // following it either way, but this gives an explicit, visible refusal
  // instead of a silent unlink-and-replace of an attacker-planted link.
  let destStat;
  try {
    destStat = lstatSync(canonicalDestination);
  } catch {
    destStat = null;
  }
  if (destStat && destStat.isSymbolicLink()) {
    throw new Error(`refusing to write to a symlinked destination: ${canonicalDestination}`);
  }
  return {
    destination,
    repoRealRoot,
    canonicalDestination,
    canonicalParent,
    existingIdentities,
  };
}

export function validateContainedFilePath(repoRoot, destPath) {
  return prepareContainedFilePath(repoRoot, destPath).destination;
}

export function createContainedWriteSession(repoRoot, destPaths) {
  if (!Array.isArray(destPaths) || destPaths.length === 0) {
    throw new TypeError('destPaths must be a non-empty array');
  }
  const prepared = destPaths.map((destPath) => prepareContainedFilePath(repoRoot, destPath));
  const [{ repoRealRoot, canonicalParent }] = prepared;
  if (prepared.some((item) => (
    item.repoRealRoot !== repoRealRoot || item.canonicalParent !== canonicalParent
  ))) {
    throw new Error('contained write session destinations must share one parent directory');
  }
  for (const item of prepared) assertDirectoryIdentities(item.existingIdentities);
  mkdirSync(canonicalParent, { recursive: true });
  for (const item of prepared) assertDirectoryIdentities(item.existingIdentities);
  const identities = captureDirectoryChain(repoRealRoot, canonicalParent, false);
  if (identities.at(-1)?.path !== canonicalParent) {
    throw new Error(`path component changed during contained write: ${canonicalParent}`);
  }
  const session = Object.freeze({});
  containedWriteSessions.set(session, {
    repoRealRoot,
    canonicalParent,
    identities,
    destinations: new Set(prepared.map((item) => item.canonicalDestination)),
  });
  return session;
}

/**
 * Write repository-owned runtime state (provenance / routing-plan JSON) to a
 * destination that is guaranteed to be repository-contained and reached
 * through no symlinked path component — never silently followed.
 *
 * J2: because the classification preflight runs before every normal review, a
 * repository can commit `.deep-review/tmp/` (or the destination file itself)
 * as a symlink and redirect this write to an arbitrary writable target
 * outside the repo. This helper refuses that outright rather than trusting
 * mkdirSync/writeFileSync's ordinary (symlink-following) path resolution.
 *
 * @param {string} repoRoot repository root (need not itself be canonicalized)
 * @param {string} destPath absolute or repo-relative destination path
 * @param {string|Buffer} data file contents
 * @param {object} [options] forwarded to atomicWriteFile (encoding, mode)
 * @returns {string} the resolved destination path that was written
 */
export function writeContainedFile(repoRoot, destPath, data, options = {}) {
  const {
    destination,
    repoRealRoot,
    canonicalDestination,
    canonicalParent,
    existingIdentities,
  } = prepareContainedFilePath(repoRoot, destPath);

  const session = typeof options === 'object'
    ? containedWriteSessions.get(options.containedWriteSession)
    : null;
  let completeIdentities;
  if (session) {
    if (
      session.repoRealRoot !== repoRealRoot
      || session.canonicalParent !== canonicalParent
      || !session.destinations.has(canonicalDestination)
    ) {
      throw new Error('contained write session does not authorize this destination');
    }
    assertDirectoryIdentities(session.identities);
    completeIdentities = session.identities;
  } else {
    // (5) Revalidate the already-observed chain around directory creation.
    // Capture newly created directories as well so every later publication
    // boundary checks the same dev/ino/type identities.
    assertDirectoryIdentities(existingIdentities);
    mkdirSync(canonicalParent, { recursive: true });
    assertDirectoryIdentities(existingIdentities);
    completeIdentities = captureDirectoryChain(repoRealRoot, canonicalParent, false);
    if (completeIdentities.at(-1)?.path !== canonicalParent) {
      throw new Error(`path component changed during contained write: ${canonicalParent}`);
    }
  }

  // This synchronous boundary hook exists so containment race behavior can be
  // tested deterministically. The guarded write revalidates before performing
  // any filesystem publication after the callback returns.
  if (typeof options === 'object') options.beforeAtomicWrite?.();
  const guard = {
    beforeTempOpen: () => assertDirectoryIdentities(completeIdentities),
    beforeRename: () => assertDirectoryIdentities(completeIdentities),
    afterRename: () => assertDirectoryIdentities(completeIdentities),
    beforeCleanup: () => assertDirectoryIdentities(completeIdentities),
  };
  atomicWriteFileGuarded(canonicalDestination, data, options, guard);
  return destination;
}

/**
 * Read a repository-owned regular file without following any symlinked path
 * component. Missing files and containment failures are intentionally
 * distinguishable only through the thrown filesystem/error result so callers
 * such as best-effort caches can fail open without probing external paths.
 */
export function readContainedFile(repoRoot, sourcePath, options = {}) {
  const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError('maxBytes must be a non-negative safe integer');
  }
  const repoRootResolved = resolve(repoRoot);
  const repoRealRoot = realpathSync(repoRootResolved);
  const source = resolve(sourcePath);
  const relFromRoot = relative(repoRootResolved, source);
  if (relFromRoot === '' || relFromRoot.startsWith('..') || isAbsolute(relFromRoot)) {
    throw new Error(`refusing to read outside the repository root: ${source}`);
  }
  const segments = relFromRoot.split(sep).filter(Boolean);
  let current = repoRootResolved;
  const identities = [];
  for (const segment of segments) {
    current = join(current, segment);
    const stat = lstatSync(current, { bigint: true });
    if (stat.isSymbolicLink()) {
      throw new Error(`refusing to read through symlinked path component: ${current}`);
    }
    if (current !== source && !stat.isDirectory()) {
      throw new Error(`refusing to read through a non-directory path component: ${current}`);
    }
    if (current === source && !stat.isFile()) {
      throw new Error(`refusing to read a non-regular file: ${current}`);
    }
    identities.push({
      path: current,
      dev: stat.dev,
      ino: stat.ino,
      type: statType(stat),
    });
  }
  const realSource = realpathSync(source);
  if (!isContained(repoRealRoot, realSource)) {
    throw new Error(`refusing to read a path that escapes the repository root: ${source}`);
  }
  const expectedFile = identities.at(-1);
  if (BigInt(maxBytes) < lstatSync(source, { bigint: true }).size) {
    throw new Error(`refusing to read a file that exceeds the maximum of ${maxBytes} bytes: ${source}`);
  }

  let descriptor;
  try {
    descriptor = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile()
      || opened.dev !== expectedFile.dev
      || opened.ino !== expectedFile.ino
    ) {
      throw new Error(`contained read target changed before open: ${source}`);
    }
    if (opened.size > BigInt(maxBytes)) {
      throw new Error(`refusing to read a file that exceeds the maximum of ${maxBytes} bytes: ${source}`);
    }
    for (const expected of identities) {
      const actual = lstatSync(expected.path, { bigint: true });
      if (
        actual.dev !== expected.dev
        || actual.ino !== expected.ino
        || statType(actual) !== expected.type
      ) {
        throw new Error(`path component changed during contained read: ${expected.path}`);
      }
    }

    const contents = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < contents.length) {
      const bytesRead = readSync(descriptor, contents, offset, contents.length - offset, offset);
      if (bytesRead === 0) {
        throw new Error(`contained read target changed size during read: ${source}`);
      }
      offset += bytesRead;
    }
    const completed = fstatSync(descriptor, { bigint: true });
    if (
      completed.dev !== opened.dev
      || completed.ino !== opened.ino
      || completed.size !== opened.size
    ) {
      throw new Error(`contained read target changed during read: ${source}`);
    }
    return contents;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function makeSecureTempPath(prefix, suffix = '') {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new TypeError('prefix must be a non-empty string');
  }
  if (typeof suffix !== 'string') {
    throw new TypeError('suffix must be a string');
  }
  if (
    suffix.includes('\0')
    || suffix.includes('/')
    || suffix.includes('\\')
    || /^[A-Za-z]:/.test(suffix)
    || suffix === '.'
    || suffix === '..'
  ) {
    throw new TypeError('suffix must be a filename suffix without path syntax');
  }

  const safePrefix = basename(prefix).replace(/[^A-Za-z0-9._-]+/g, '-') || 'deep-review';
  const directory = mkdtempSync(join(tmpdir(), `${safePrefix}-`));
  chmodSync(directory, 0o700);
  return join(directory, `${safePrefix}-${randomUUID()}${suffix}`);
}
