import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { patchTopLevelConfig, readTopLevelConfig } from './config.mjs';
import { stableDigest, walkRepositoryFiles } from './fingerprint.mjs';
import { createSensitiveFileScanner } from './sensitive-files.mjs';

const ACK_FINGERPRINT = 'agy_sensitive_acked_fingerprint';
const ACK_AT = 'agy_sensitive_acked_at';

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new TypeError(`${name} must be a non-empty NUL-free string`);
  }
  return value;
}

function patternData(pluginRoot) {
  const path = join(pluginRoot, 'hooks', 'scripts', 'lib', 'sensitive-patterns.list');
  const data = readFileSync(path);
  if (data.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    throw new Error('canonical sensitive pattern data has UTF-8 BOM');
  }
  return data;
}

function privacyFingerprint(patternBytes, hitEntries) {
  const patternVersion = createHash('sha256').update(patternBytes).digest('hex');
  return stableDigest(
    hitEntries.map((entry) => ({ path: entry.relative, value: Buffer.from('sensitive') })),
    `deep-review-agy-privacy-v1\0${patternVersion}`,
  );
}

export function scanAgyPrivacy({ repo, pluginRoot }) {
  const root = realpathSync(resolve(requiredString(repo, 'repo')));
  const rootPlugin = resolve(requiredString(pluginRoot, 'pluginRoot'));
  const patterns = patternData(rootPlugin);
  const entries = walkRepositoryFiles(root, { standardExclusions: false });
  const displays = entries.map((entry) => entry.display);
  const scanSensitiveFiles = createSensitiveFileScanner({
    readPatternData: () => patterns.toString('utf8'),
  });
  const matched = new Set(scanSensitiveFiles({ pluginRoot: rootPlugin, files: displays }));
  const hitEntries = entries.filter((entry) => matched.has(entry.display));
  return {
    hits: hitEntries.map((entry) => entry.display),
    fingerprint: privacyFingerprint(patterns, hitEntries),
    patternVersion: createHash('sha256').update(patterns).digest('hex'),
  };
}

export async function prepareAgyPrivacy(options = {}) {
  const repo = resolve(requiredString(options.repo, 'repo'));
  const pluginRoot = resolve(requiredString(options.pluginRoot, 'pluginRoot'));
  const configPath = resolve(requiredString(options.configPath, 'configPath'));
  const approval = options.approval ?? 'auto';
  if (!['auto', 'approve', 'decline'].includes(approval)) {
    throw new TypeError('approval must be auto, approve, or decline');
  }

  let scan;
  try {
    scan = scanAgyPrivacy({ repo, pluginRoot });
  } catch (error) {
    return {
      hits: [],
      fingerprint: null,
      outcome: 'needs_approval',
      error: `${error.code || error.name || 'ERROR'}: ${error.message}`,
    };
  }
  let config;
  try {
    config = readTopLevelConfig(configPath);
  } catch (error) {
    return {
      ...scan,
      outcome: 'needs_approval',
      error: `${error.code || error.name || 'ERROR'}: ${error.message}`,
    };
  }
  const stored = typeof config[ACK_FINGERPRINT] === 'string' ? config[ACK_FINGERPRINT] : '';
  const now = typeof options.now === 'function' ? options.now() : new Date().toISOString();

  if (scan.hits.length === 0) {
    if (stored !== scan.fingerprint || typeof config[ACK_AT] !== 'string' || config[ACK_AT] === '') {
      try {
        patchTopLevelConfig(configPath, {
          [ACK_FINGERPRINT]: scan.fingerprint,
          [ACK_AT]: now,
        });
      } catch (error) {
        return {
          ...scan,
          outcome: 'needs_approval',
          error: `${error.code || error.name || 'ERROR'}: ${error.message}`,
        };
      }
    }
    return { ...scan, outcome: 'auto_ack', error: null };
  }
  if (stored === scan.fingerprint) {
    return { ...scan, outcome: 'acknowledged', error: null };
  }
  if (approval === 'approve') {
    try {
      patchTopLevelConfig(configPath, {
        [ACK_FINGERPRINT]: scan.fingerprint,
        [ACK_AT]: now,
      });
    } catch (error) {
      return {
        ...scan,
        outcome: 'needs_approval',
        error: `${error.code || error.name || 'ERROR'}: ${error.message}`,
      };
    }
    return { ...scan, outcome: 'acknowledged', error: null };
  }
  if (approval === 'decline') return { ...scan, outcome: 'declined', error: null };
  return { ...scan, outcome: 'needs_approval', error: null };
}
