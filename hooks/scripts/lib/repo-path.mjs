import {
  lstatSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { resolve, sep } from 'node:path';
import { decodeGitPath, encodeGitPath } from './git.mjs';

const FORWARD_SLASH = 0x2f;
const BACKSLASH = 0x5c;
const NUL = 0x00;

function assertRawPath(rawPath) {
  if (!Buffer.isBuffer(rawPath)) {
    throw new TypeError('rawPath must be a Buffer');
  }
  if (rawPath.length === 0) {
    throw new Error('Phase 6 path must be a non-empty repository-relative path');
  }
  if (rawPath.includes(NUL)) {
    throw new Error('Phase 6 path must not contain NUL');
  }
  if (rawPath[0] === FORWARD_SLASH || rawPath[0] === BACKSLASH) {
    const kind = rawPath[0] === BACKSLASH && rawPath[1] === BACKSLASH
      ? 'UNC'
      : 'absolute';
    throw new Error(`Phase 6 ${kind} path is not repository-relative`);
  }
  if (
    rawPath.length >= 2
    && ((rawPath[0] >= 0x41 && rawPath[0] <= 0x5a) || (rawPath[0] >= 0x61 && rawPath[0] <= 0x7a))
    && rawPath[1] === 0x3a
  ) {
    throw new Error('Phase 6 drive-qualified path is not repository-relative');
  }
}

function rawSegments(rawPath) {
  const segments = [];
  let start = 0;
  for (let index = 0; index <= rawPath.length; index += 1) {
    const atEnd = index === rawPath.length;
    const separator = !atEnd && (rawPath[index] === FORWARD_SLASH || rawPath[index] === BACKSLASH);
    if (!atEnd && !separator) continue;
    const segment = rawPath.subarray(start, index);
    if (segment.length === 0) {
      throw new Error('Phase 6 path contains an empty repository-relative segment');
    }
    if (segment.equals(Buffer.from('..'))) {
      throw new Error('Phase 6 path contains a forbidden dot-dot segment');
    }
    if (segment.equals(Buffer.from('.'))) {
      throw new Error('Phase 6 path contains a non-canonical dot segment');
    }
    if (segment.toString('latin1').toLowerCase() === '.git') {
      throw new Error('Phase 6 path may not address Git metadata');
    }
    segments.push(Buffer.from(segment));
    start = index + 1;
  }
  return segments;
}

export function validatePhase6RepoPathSyntax(rawPath) {
  assertRawPath(rawPath);
  return rawSegments(rawPath).map((segment) => Buffer.from(segment));
}

function nativePath(rootBuffer, segments, count = segments.length) {
  const separator = Buffer.from(sep);
  const pieces = [rootBuffer];
  for (let index = 0; index < count; index += 1) {
    pieces.push(separator, segments[index]);
  }
  return Buffer.concat(pieces);
}

function realBuffer(path) {
  return Buffer.from(realpathSync.native(path, { encoding: 'buffer' }));
}

function bufferWithin(root, candidate) {
  if (process.platform === 'win32') {
    const rootText = root.toString('utf8').toLowerCase();
    const candidateText = candidate.toString('utf8').toLowerCase();
    return candidateText === rootText
      || (rootText.endsWith(sep) ? candidateText.startsWith(rootText) : candidateText.startsWith(`${rootText}${sep}`));
  }
  if (root.at(-1) === Buffer.from(sep)[0]) return candidate.subarray(0, root.length).equals(root);
  return candidate.equals(root)
    || candidate.subarray(0, root.length).equals(root)
      && candidate[root.length] === Buffer.from(sep)[0];
}

/**
 * Validate one repository-relative path without decoding away non-UTF-8 bytes.
 * The returned Buffer is the same byte sequence supplied by the caller.
 */
export function validatePhase6RepoPath({ repo, rawPath }) {
  if (typeof repo !== 'string' || repo.length === 0) {
    throw new TypeError('repo must be a non-empty string');
  }
  const segments = validatePhase6RepoPathSyntax(rawPath);
  const repository = resolve(repo);
  const repositoryReal = realBuffer(repository);
  if (!statSync(repositoryReal).isDirectory()) {
    throw new Error('Phase 6 repository root is not a directory');
  }

  for (let count = 1; count <= segments.length; count += 1) {
    const prefix = nativePath(repositoryReal, segments, count);
    let stat;
    try {
      stat = lstatSync(prefix);
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }

    if (stat.isSymbolicLink()) {
      const target = realBuffer(prefix);
      if (!bufferWithin(repositoryReal, target)) {
        throw new Error('Phase 6 path symlink resolves outside the repository');
      }
      if (count < segments.length && !statSync(target).isDirectory()) {
        throw new Error('Phase 6 path has a non-directory symlink ancestor');
      }
    } else if (count < segments.length && !stat.isDirectory()) {
      throw new Error('Phase 6 path has a non-directory ancestor');
    }
  }

  return {
    rawPath: Buffer.from(rawPath),
    base64: rawPath.toString('base64'),
    absolutePath: nativePath(repositoryReal, segments),
    repositoryReal,
  };
}

export function decodeRepoPath(rawPath) {
  if (!Buffer.isBuffer(rawPath)) throw new TypeError('rawPath must be a Buffer');
  return decodeGitPath(rawPath);
}

export function encodeRepoPath(value) {
  return encodeGitPath(value);
}
