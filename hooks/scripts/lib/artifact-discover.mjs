// Artifact discovery (§8.1-§8.4).
//
// Turns the current git change scope into ArtifactDescriptors (§8.2). It reuses
// the existing change-files manifest logic (`buildChangeFiles`) as the discovery
// source of truth, then enriches each entry with the descriptor fields the
// classifier and later phases need. Content is read as bounded, untrusted DATA
// (D9) — never interpreted.

import { createHash } from 'node:crypto';
import { openSync, closeSync, readSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { buildChangeFiles } from './review-target.mjs';

// Bytes of content handed to the classifier. Enough to cover frontmatter, the
// heading index, and a representative keyword sample without loading giant docs.
const DEFAULT_MAX_CONTENT_BYTES = 256 * 1024;
const BINARY_SNIFF_BYTES = 8192;

// deep-suite runtime state is never a review target — the classifier must not
// discover its own provenance output (`.deep-review/tmp/`) or deep-work state.
// These are always excluded, independent of the repository's .gitignore.
const RUNTIME_STATE_PREFIXES = ['.deep-review/', '.deep-work/', '.deep-loop/'];

function isRuntimeStatePath(relativePath) {
  const normalized = relativePath.replace(/\\/gu, '/');
  return RUNTIME_STATE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function readBounded(absolutePath, maxBytes) {
  let fd;
  try {
    const stat = statSync(absolutePath);
    if (!stat.isFile()) return null;
    const size = stat.size;
    const toRead = Math.min(size, maxBytes);
    const buffer = Buffer.allocUnsafe(toRead);
    fd = openSync(absolutePath, 'r');
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

  const records = buildChangeFiles({ repo, changeState, reviewBase, filesFromZ })
    .filter((record) => !isRuntimeStatePath(record.path));
  const descriptors = [];

  records.forEach((record, index) => {
    const relativePath = record.path;
    const extension = extname(relativePath).toLowerCase();
    const absolutePath = resolve(repo, relativePath);
    const read = readBounded(absolutePath, maxContentBytes);

    if (read === null) {
      // Deleted or unreadable — metadata only, no content to classify.
      descriptors.push({
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
        is_binary: false,
        payload_strategy: 'metadata-only',
        content_ref: { type: 'path', value: relativePath },
        content: '',
      });
      return;
    }

    const isBinary = isBinaryBuffer(read.buffer);
    const digest = `sha256:${createHash('sha256').update(read.buffer).digest('hex')}`;
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
      payload_strategy: payloadStrategy,
      content_ref: { type: 'path', value: relativePath },
      content,
    });
  });

  return descriptors;
}
