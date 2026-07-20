// Artifact discovery (§8.1-§8.4).
//
// Turns the current git change scope into ArtifactDescriptors (§8.2). It reuses
// the existing change-files manifest logic (`buildChangeFiles`) as the discovery
// source of truth, then enriches each entry with the descriptor fields the
// classifier and later phases need. Content is read as bounded, untrusted DATA
// (D9) — never interpreted.
//
// Containment (C1): content is only ever read from a regular file whose real
// path stays inside the repository root. Symlinks are treated as metadata only
// (never dereferenced), and any target that resolves outside the repo is
// refused. This keeps the direct-filesystem reader from becoming an
// out-of-repo read primitive when the reviewed change is untrusted.

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import {
  extname,
  isAbsolute,
  relative,
  resolve,
} from 'node:path';
import { buildChangeFiles } from './review-target.mjs';

// Bytes of content handed to the classifier. Enough to cover frontmatter, the
// heading index, and a representative keyword sample without loading giant docs.
const DEFAULT_MAX_CONTENT_BYTES = 256 * 1024;
const BINARY_SNIFF_BYTES = 8192;

// Open read-only and, where the platform supports it, refuse to follow a final
// symlink component. O_NOFOLLOW is POSIX-only (undefined on Windows) — fall back
// to a plain read-only open there; the lstat + realpath checks still hold.
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const OPEN_READ_NOFOLLOW = (fsConstants.O_RDONLY ?? 0) | O_NOFOLLOW;

// deep-suite runtime state is never a review target — the classifier must not
// discover its own provenance output (`.deep-review/tmp/`) or deep-work state.
// These are always excluded, independent of the repository's .gitignore.
const RUNTIME_STATE_PREFIXES = ['.deep-review/', '.deep-work/', '.deep-loop/'];

function isRuntimeStatePath(relativePath) {
  const normalized = relativePath.replace(/\\/gu, '/');
  return RUNTIME_STATE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

// True when `candidate` is the repo root itself or lives beneath it. Both paths
// must already be real (symlink-resolved) so a symlinked parent directory that
// escapes the tree is rejected here.
function isContained(root, candidate) {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

// Read up to `maxBytes` of a contained, regular file. Returns one of:
//   - { buffer, byteSize, truncated }  — a normal read
//   - { contentOmitted, reason }       — symlink / out-of-repo (metadata only)
//   - null                             — deleted, unreadable, or a TOCTOU swap
function readBounded(absolutePath, maxBytes, repoRealRoot) {
  // (a) Never dereference a symlink. lstat inspects the link itself, so a
  //     symlinked leaf is caught before any content is touched.
  let linkStat;
  try {
    linkStat = lstatSync(absolutePath);
  } catch {
    return null;
  }
  if (linkStat.isSymbolicLink()) return { contentOmitted: true, reason: 'symlink' };
  if (!linkStat.isFile()) return null;

  // (b) Containment: the fully-resolved real path must stay inside the repo.
  //     realpath resolves every intermediate symlink, so a path that escapes
  //     through a symlinked directory is refused too.
  let realPath;
  try {
    realPath = realpathSync(absolutePath);
  } catch {
    return null;
  }
  if (!isContained(repoRealRoot, realPath)) return { contentOmitted: true, reason: 'out-of-repo' };

  // (c) Open no-follow and re-verify via fstat, closing the lstat -> open
  //     symlink-swap TOCTOU window: if the leaf became a symlink after the
  //     lstat check, the no-follow open fails instead of following it.
  let fd;
  try {
    fd = openSync(absolutePath, OPEN_READ_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const size = stat.size;
    const toRead = Math.min(size, maxBytes);
    const buffer = Buffer.allocUnsafe(toRead);
    let offset = 0;
    while (offset < toRead) {
      const read = readSync(fd, buffer, offset, toRead - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    return { buffer: buffer.subarray(0, offset), byteSize: size, truncated: size > toRead };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function isBinaryBuffer(buffer) {
  const window = buffer.subarray(0, Math.min(buffer.length, BINARY_SNIFF_BYTES));
  return window.includes(0);
}

function sourceForStatus(status) {
  if (status === 'session') return 'session';
  if (status === 'non-git') return 'non-git';
  return 'working-tree';
}

function isTrackedStatus(status) {
  return !['untracked', 'initial', 'non-git', 'session'].includes(status);
}

function artifactId(index) {
  return `artifact-${String(index + 1).padStart(3, '0')}`;
}

// A descriptor that carries no content — used for deleted/unreadable files,
// symlinks and out-of-repo targets (C1), and preserved binaries (W1).
function metadataOnlyDescriptor(index, record, extension, relativePath, flags = {}) {
  const { isBinary = false, isSymlink = false } = flags;
  return {
    artifact_id: artifactId(index),
    path: relativePath,
    source: sourceForStatus(record.status),
    git_status: record.status,
    extension,
    byte_size: 0,
    line_count: 0,
    digest: null,
    is_tracked: isTrackedStatus(record.status),
    is_ignored: false,
    is_binary: isBinary,
    is_symlink: isSymlink,
    payload_strategy: 'metadata-only',
    content_ref: { type: 'path', value: relativePath },
    content: '',
  };
}

/**
 * Build ArtifactDescriptors for the given change scope.
 *
 * @param {object} options
 * @param {string} options.repo repository root
 * @param {string} options.changeState one of the change-files manifest states
 * @param {string} [options.reviewBase] required for the `clean` state
 * @param {Buffer|Uint8Array|string} [options.filesFromZ] extra NUL-delimited paths
 * @param {number} [options.maxContentBytes]
 * @returns {Array<object>} descriptors, each with an attached bounded `content`
 */
export function discoverArtifacts(options = {}) {
  const {
    repo,
    changeState,
    reviewBase = '',
    filesFromZ,
    maxContentBytes = DEFAULT_MAX_CONTENT_BYTES,
  } = options;

  // Resolve the repository root once so containment compares real paths (this
  // also normalises platform quirks such as macOS /tmp -> /private/tmp).
  let repoRealRoot;
  try {
    repoRealRoot = realpathSync(resolve(repo));
  } catch {
    repoRealRoot = resolve(repo);
  }

  // `includeBinary` preserves binary members as metadata (W1): without it the
  // shared manifest silently drops them, leaving `is_binary` and the
  // unsupported-binary branch unreachable for real git scopes.
  const records = buildChangeFiles({ repo, changeState, reviewBase, filesFromZ, includeBinary: true })
    .filter((record) => !isRuntimeStatePath(record.path));
  const descriptors = [];

  records.forEach((record, index) => {
    const relativePath = record.path;
    const extension = extname(relativePath).toLowerCase();
    const absolutePath = resolve(repo, relativePath);

    // Binaries preserved by the manifest are metadata-only — their bytes are
    // never read, and they classify as unsupported-binary downstream.
    if (record.is_binary) {
      descriptors.push(metadataOnlyDescriptor(index, record, extension, relativePath, { isBinary: true }));
      return;
    }

    const read = readBounded(absolutePath, maxContentBytes, repoRealRoot);

    if (read === null || read.contentOmitted) {
      // Deleted, unreadable, a symlink, or a target that resolves outside the
      // repository (C1) — metadata only, no content classified.
      descriptors.push(metadataOnlyDescriptor(index, record, extension, relativePath, {
        isSymlink: read?.reason === 'symlink',
      }));
      return;
    }

    const isBinary = isBinaryBuffer(read.buffer);
    const digestAlgo = read.truncated ? 'sha256-partial' : 'sha256';
    const digest = `${digestAlgo}:${createHash('sha256').update(read.buffer).digest('hex')}`;
    const content = isBinary ? '' : read.buffer.toString('utf8');
    const lineCount = isBinary || content.length === 0 ? 0 : content.split(/\r?\n/u).length;

    let payloadStrategy = 'full-text';
    if (isBinary) payloadStrategy = 'metadata-only';
    else if (read.truncated) payloadStrategy = 'heading-index';

    descriptors.push({
      artifact_id: artifactId(index),
      path: relativePath,
      source: sourceForStatus(record.status),
      git_status: record.status,
      extension,
      byte_size: read.byteSize,
      line_count: lineCount,
      digest,
      is_tracked: isTrackedStatus(record.status),
      is_ignored: false,
      is_binary: isBinary,
      is_symlink: false,
      payload_strategy: payloadStrategy,
      content_ref: { type: 'path', value: relativePath },
      content,
    });
  });

  return descriptors;
}
