import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

class SensitivePatternError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'SensitivePatternError';
    this.code = 'SENSITIVE_PATTERN_DATA_UNAVAILABLE';
  }
}

function escapeRegex(character) {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

function globSource(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      while (pattern[index + 1] === '*') index += 1;
      source += '.*';
    } else if (character === '?') {
      source += '.';
    } else {
      source += escapeRegex(character);
    }
  }
  return source;
}

function compilePattern(rawPattern) {
  const normalized = rawPattern.replaceAll('\\', '/').toLowerCase();
  if (normalized.startsWith('**/')) {
    const inner = normalized.slice(3);
    return {
      basename: new RegExp(`^${globSource(inner)}$`, 'u'),
      full: new RegExp(`^(?:.*/)?${globSource(inner)}$`, 'u'),
    };
  }
  const expression = new RegExp(`^${globSource(normalized)}$`, 'u');
  return { basename: expression, full: expression };
}

function readPatterns(pluginRoot, readPatternData) {
  const listPath = join(
    resolve(pluginRoot),
    'hooks',
    'scripts',
    'lib',
    'sensitive-patterns.list',
  );
  let source;
  try {
    source = readPatternData(listPath, 'utf8');
  } catch (error) {
    const condition = error?.code === 'ENOENT' ? 'missing' : 'unreadable';
    throw new SensitivePatternError(
      `canonical sensitive pattern data is ${condition}: ${listPath}`,
      error,
    );
  }
  const patterns = source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (patterns.length === 0) {
    throw new SensitivePatternError(
      `canonical sensitive pattern data is empty: ${listPath}`,
    );
  }
  return patterns;
}

export function createSensitiveFileScanner(options = {}) {
  const readPatternData = options.readPatternData || readFileSync;
  if (typeof readPatternData !== 'function') {
    throw new TypeError('readPatternData must be a function');
  }
  return function scanSensitiveFilesWithTrustedData({ pluginRoot, files }) {
    if (typeof pluginRoot !== 'string' || pluginRoot.length === 0) {
      throw new TypeError('pluginRoot must be a non-empty string');
    }
    if (!Array.isArray(files)) throw new TypeError('files must be an array');
    const patterns = readPatterns(pluginRoot, readPatternData).map(compilePattern);

    return files.filter((file) => {
      if (typeof file !== 'string' || file.includes('\0')) {
        throw new TypeError('files must contain NUL-free strings');
      }
      const normalized = file.replaceAll('\\', '/').toLowerCase();
      const name = basename(normalized);
      return patterns.some((pattern) => (
        pattern.basename.test(name) || pattern.full.test(normalized)
      ));
    });
  };
}

export const scanSensitiveFiles = createSensitiveFileScanner();
