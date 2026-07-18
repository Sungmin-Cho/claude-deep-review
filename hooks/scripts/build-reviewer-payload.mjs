#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildChangeFiles,
  serializeChangeFiles,
} from './lib/review-target.mjs';
import {
  atomicWriteFile,
  makeSecureTempPath,
  resolvePluginRoot,
} from './lib/runtime-context.mjs';

const DOCTRINE_WARNING = 'fp-doctrine extraction failed (injection skipped)';
const SECTION_ORDER = [
  ['REVIEW SUPPRESSION DOCTRINE', 'doctrine'],
  ['CHANGED FILES (cross-file context)', 'changeFiles'],
  ['PROJECT RULES / CONTRACT / HEALTH', 'context'],
  ['DIFF UNDER REVIEW', 'diff'],
];

function markerLine(name, side) {
  return `<!-- ${name}:${side} -->`;
}

export function extractAnchoredBlock(text, name) {
  if (typeof text !== 'string') throw new TypeError('anchor source must be a string');
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('anchor name must be a non-empty string');
  }
  const lines = text.split(/\r\n|\n|\r/);
  const startMarker = markerLine(name, 'start');
  const endMarker = markerLine(name, 'end');
  const starts = [];
  const ends = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === startMarker) starts.push(index);
    if (lines[index].trim() === endMarker) ends.push(index);
  }
  if (starts.length !== 1 || ends.length !== 1) {
    throw new Error(`${name} marker count must be exactly one pair`);
  }
  if (starts[0] >= ends[0]) throw new Error(`${name} markers are reversed`);
  const body = lines.slice(starts[0] + 1, ends[0]).join('\n').replace(/\n+$/g, '');
  if (body.replace(/\s/g, '') === '') throw new Error(`${name} anchor body is empty`);
  return body;
}

export function extractFalsePositiveDoctrine(criteriaText) {
  const doctrine = extractAnchoredBlock(criteriaText, 'fp-doctrine');
  const conservative = extractAnchoredBlock(criteriaText, 'fp-conservative');
  const bulletCount = doctrine.split('\n').filter((line) => /^\s*-/.test(line)).length;
  if (bulletCount < 4) throw new Error(`fp-doctrine requires at least four bullets, got ${bulletCount}`);
  for (const keyword of ['pre-existing', '린터', '추측', '취향']) {
    if (!doctrine.includes(keyword)) throw new Error(`fp-doctrine missing canonical keyword ${keyword}`);
  }
  if (!conservative.includes('강등하지 않는다')) {
    throw new Error('fp-conservative missing reachability phrase');
  }
  if (/VOICE-6|confidence/.test(`${conservative}\n${doctrine}`)) {
    throw new Error('VOICE-6/confidence text must remain outside doctrine anchors');
  }
  return [
    '### Severity — conservative default',
    conservative,
    '',
    '### Findings to suppress / downgrade',
    doctrine,
    '',
  ].join('\n');
}

export function assembleReviewerPayload(sections = {}) {
  let payload = '';
  for (const [title, key] of SECTION_ORDER) {
    const content = sections[key] ?? '';
    if (typeof content !== 'string') throw new TypeError(`${key} must be a string`);
    if (content.length === 0) continue;
    payload += `\n===== ${title} =====\n${content}\n`;
  }
  return payload;
}

function contentFromOption(options, valueKey, fileKey) {
  if (options[valueKey] !== undefined) {
    if (typeof options[valueKey] !== 'string') throw new TypeError(`${valueKey} must be a string`);
    return options[valueKey];
  }
  if (!options[fileKey]) return '';
  return readFileSync(options[fileKey], 'utf8');
}

export function buildReviewerPayload(options = {}) {
  const root = resolve(options.pluginRoot ?? resolvePluginRoot());
  const warnings = [];
  let doctrine = '';
  try {
    const criteriaPath = join(
      root,
      'skills',
      'deep-review-workflow',
      'references',
      'review-criteria.md',
    );
    doctrine = extractFalsePositiveDoctrine(readFileSync(criteriaPath, 'utf8'));
  } catch {
    warnings.push(DOCTRINE_WARNING);
  }

  let changeFiles = '';
  let changeFilesCount = 0;
  if (options.changeState) {
    try {
      const records = buildChangeFiles({
        repo: options.repo ?? '.',
        changeState: options.changeState,
        reviewBase: options.reviewBase,
        filesFromZ: options.filesFromZ,
        maxEntries: options.maxEntries,
        maxBytes: options.maxBytes,
      });
      changeFiles = serializeChangeFiles(records);
      changeFilesCount = records.length;
    } catch (error) {
      warnings.push(`change-files construction failed (section skipped): ${error.message}`);
    }
  }

  const context = contentFromOption(options, 'context', 'contextFile');
  const diff = contentFromOption(options, 'diff', 'diffFile');
  const payload = assembleReviewerPayload({ doctrine, changeFiles, context, diff });
  const promptFile = makeSecureTempPath('deep-review-prompt', '.md');
  atomicWriteFile(promptFile, payload, { encoding: 'utf8', mode: 0o600 });
  return { promptFile: resolve(promptFile), warnings, changeFilesCount };
}

function parseArguments(argv) {
  const options = {};
  const mappings = new Map([
    ['--plugin-root', 'pluginRoot'],
    ['--repo', 'repo'],
    ['--change-state', 'changeState'],
    ['--review-base', 'reviewBase'],
    ['--files-from-z', 'filesFromZ'],
    ['--context-file', 'contextFile'],
    ['--diff-file', 'diffFile'],
    ['--max-entries', 'maxEntries'],
    ['--max-bytes', 'maxBytes'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = mappings.get(argv[index]);
    if (!key) throw new Error(`unknown argument: ${argv[index]}`);
    if (argv[index + 1] === undefined) throw new Error(`${argv[index]} requires a value`);
    options[key] = argv[index + 1];
    index += 1;
  }
  options.maxEntries ??= process.env.OCR_CHANGE_FILES_MAX_ENTRIES;
  options.maxBytes ??= process.env.OCR_CHANGE_FILES_MAX_BYTES;
  return options;
}

export function runBuildReviewerPayloadCli(argv = process.argv.slice(2)) {
  const result = buildReviewerPayload(parseArguments(argv));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  try {
    runBuildReviewerPayloadCli();
  } catch (error) {
    process.stderr.write(`build-reviewer-payload: ${error.message}\n`);
    process.exitCode = 2;
  }
}
