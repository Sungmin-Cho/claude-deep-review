import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
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

export function atomicWriteFile(filePath, data, options = {}) {
  const normalized = typeof options === 'string' ? { encoding: options } : options;
  const destination = resolve(filePath);
  const parent = dirname(destination);
  const mode = normalized.mode ?? 0o600;
  const temporary = join(parent, `.${basename(destination)}.${randomUUID()}.tmp`);
  let descriptor;

  mkdirSync(parent, { recursive: true });
  try {
    descriptor = openSync(temporary, 'wx', mode);
    writeFileSync(descriptor, data, normalized.encoding ? { encoding: normalized.encoding } : undefined);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, destination);
    chmodSync(destination, mode);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original write error.
      }
    }
    rmSync(temporary, { force: true });
    throw error;
  }
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
  const ancestorSegments = segments.slice(0, -1);
  let current = repoRootResolved;
  let deepestExisting = repoRootResolved;
  for (const segment of ancestorSegments) {
    current = join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      break;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`refusing to write through symlinked path component: ${current}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`refusing to write through a non-directory path component: ${current}`);
    }
    deepestExisting = current;
  }

  // (3) The deepest EXISTING ancestor must resolve inside the real repo root.
  let deepestRealPath;
  try {
    deepestRealPath = realpathSync(deepestExisting);
  } catch {
    throw new Error(`refusing to write: ancestor path is unreadable: ${deepestExisting}`);
  }
  if (!isContained(repoRealRoot, deepestRealPath)) {
    throw new Error(`refusing to write through a path component that escapes the repository root: ${deepestExisting}`);
  }

  // (4) The destination itself, if it already exists, must not be a symlink.
  // atomicWriteFile's rename replaces the link entry itself rather than
  // following it either way, but this gives an explicit, visible refusal
  // instead of a silent unlink-and-replace of an attacker-planted link.
  let destStat;
  try {
    destStat = lstatSync(destination);
  } catch {
    destStat = null;
  }
  if (destStat && destStat.isSymbolicLink()) {
    throw new Error(`refusing to write to a symlinked destination: ${destination}`);
  }

  // (5) Create any missing directories under the validated chain, then
  // delegate to atomicWriteFile's no-follow temp-file + rename discipline.
  mkdirSync(dirname(destination), { recursive: true });
  atomicWriteFile(destination, data, options);
  return destination;
}

/**
 * Read a repository-owned regular file without following any symlinked path
 * component. Missing files and containment failures are intentionally
 * distinguishable only through the thrown filesystem/error result so callers
 * such as best-effort caches can fail open without probing external paths.
 */
export function readContainedFile(repoRoot, sourcePath) {
  const repoRootResolved = resolve(repoRoot);
  const repoRealRoot = realpathSync(repoRootResolved);
  const source = resolve(sourcePath);
  const relFromRoot = relative(repoRootResolved, source);
  if (relFromRoot === '' || relFromRoot.startsWith('..') || isAbsolute(relFromRoot)) {
    throw new Error(`refusing to read outside the repository root: ${source}`);
  }
  const segments = relFromRoot.split(sep).filter(Boolean);
  let current = repoRootResolved;
  for (const segment of segments) {
    current = join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`refusing to read through symlinked path component: ${current}`);
    }
    if (current !== source && !stat.isDirectory()) {
      throw new Error(`refusing to read through a non-directory path component: ${current}`);
    }
    if (current === source && !stat.isFile()) {
      throw new Error(`refusing to read a non-regular file: ${current}`);
    }
  }
  const realSource = realpathSync(source);
  if (!isContained(repoRealRoot, realSource)) {
    throw new Error(`refusing to read a path that escapes the repository root: ${source}`);
  }
  return readFileSync(source);
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
