#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOP_LEVEL_FIELDS = new Set([
  'slice',
  'title',
  'source_plan',
  'created_at',
  'status',
  'criteria',
]);
const CRITERION_FIELDS = new Set([
  'id',
  'description',
  'verification',
  'prerequisites',
  'status',
  'evidence',
]);
const REQUIRED_TOP_LEVEL = ['slice', 'title', 'source_plan', 'created_at', 'criteria'];
const REQUIRED_CRITERION = ['id', 'description', 'verification', 'prerequisites'];
const VERIFICATION_VALUES = new Set(['auto', 'manual', 'mixed']);

function contractError(message, lineNumber) {
  return new Error(`${message} at line ${lineNumber}`);
}

function unquotedProjection(text, lineNumber) {
  let doubleQuoted = false;
  let singleQuoted = false;
  let escaped = false;
  let projected = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (doubleQuoted) {
      projected += ' ';
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') doubleQuoted = false;
      continue;
    }
    if (singleQuoted) {
      projected += ' ';
      if (character === "'" && text[index + 1] === "'") {
        projected += ' ';
        index += 1;
      } else if (character === "'") singleQuoted = false;
      continue;
    }
    if (character === '"') {
      doubleQuoted = true;
      projected += ' ';
    } else if (character === "'") {
      singleQuoted = true;
      projected += ' ';
    } else {
      projected += character;
    }
  }
  if (doubleQuoted || singleQuoted) throw contractError('unterminated quoted scalar', lineNumber);
  return projected;
}

function stripComment(text, lineNumber) {
  const projection = unquotedProjection(text, lineNumber);
  for (let index = 0; index < projection.length; index += 1) {
    if (
      projection[index] === '#'
      && (index === 0 || /\s/.test(projection[index - 1]))
    ) return text.slice(0, index).trimEnd();
  }
  return text.trimEnd();
}

function validateUnsupportedSyntax(text, lineNumber) {
  const projection = unquotedProjection(text, lineNumber);
  if (/^\s*(?:---|\.\.\.|%YAML\b)/.test(projection)) {
    throw contractError('YAML directives and document markers are unsupported', lineNumber);
  }
  if (/(^|\s)[&*!][^\s,\]}]+/.test(projection)) {
    throw contractError('YAML anchors, aliases, and tags are unsupported', lineNumber);
  }
  if (/[{}]/.test(projection)) {
    throw contractError('flow mappings are unsupported', lineNumber);
  }
}

function tokenize(text) {
  const normalized = text.startsWith('\ufeff') ? text.slice(1) : text;
  const physical = normalized.split(/\r\n|\n|\r/);
  const tokens = [];
  for (let index = 0; index < physical.length; index += 1) {
    const raw = physical[index];
    const indentation = /^[ \t]*/.exec(raw)[0];
    if (indentation.includes('\t')) {
      throw contractError('tabs used as indentation are unsupported', index + 1);
    }
    const withoutComment = stripComment(raw.slice(indentation.length), index + 1);
    if (withoutComment.trim() === '') continue;
    const content = withoutComment.trimEnd();
    validateUnsupportedSyntax(content, index + 1);
    tokens.push({
      content,
      indent: indentation.length,
      line: index + 1,
    });
  }
  return tokens;
}

function findMappingColon(text, lineNumber) {
  const projection = unquotedProjection(text, lineNumber);
  return projection.indexOf(':');
}

function parseMapping(text, lineNumber) {
  const colon = findMappingColon(text, lineNumber);
  if (colon < 1) throw contractError('expected a mapping key', lineNumber);
  const key = text.slice(0, colon).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) || key === '<<') {
    throw contractError(`unsupported mapping key ${key || '<empty>'}`, lineNumber);
  }
  return { key, rawValue: text.slice(colon + 1).trim() };
}

function parseScalar(raw, lineNumber) {
  const value = raw.trim();
  if (value === '') throw contractError('empty scalar is not supported here', lineNumber);
  if (/^[|>]/.test(value)) {
    throw contractError('block scalars are unsupported', lineNumber);
  }
  validateUnsupportedSyntax(value, lineNumber);
  if (value.startsWith('"')) {
    try {
      const decoded = JSON.parse(value);
      if (typeof decoded !== 'string') throw new Error('not a string');
      return decoded;
    } catch {
      throw contractError('invalid double-quoted scalar', lineNumber);
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      throw contractError('invalid single-quoted scalar', lineNumber);
    }
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value === 'null' || value === '~') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/[[\]]/.test(unquotedProjection(value, lineNumber))) {
    throw contractError('malformed flow sequence', lineNumber);
  }
  if (/(^|\s):\s/.test(unquotedProjection(value, lineNumber))) {
    throw contractError('unquoted colon-space scalar is unsupported', lineNumber);
  }
  return value;
}

function splitInlineItems(body, lineNumber) {
  const projection = unquotedProjection(body, lineNumber);
  const items = [];
  let start = 0;
  for (let index = 0; index < projection.length; index += 1) {
    if (projection[index] !== ',') continue;
    items.push(body.slice(start, index).trim());
    start = index + 1;
  }
  items.push(body.slice(start).trim());
  return items;
}

function parseInlineSequence(raw, lineNumber) {
  const value = raw.trim();
  if (!value.startsWith('[') || !value.endsWith(']')) {
    throw contractError('expected a sequence', lineNumber);
  }
  const body = value.slice(1, -1).trim();
  if (body === '') return [];
  return splitInlineItems(body, lineNumber).map((item) => {
    if (item === '') throw contractError('empty sequence item', lineNumber);
    const scalar = parseScalar(item, lineNumber);
    if (scalar !== null && typeof scalar !== 'string') {
      throw contractError('sequence items must be strings or null', lineNumber);
    }
    return scalar;
  });
}

function parseBlockSequence(tokens, startIndex, indent, fieldLine) {
  const values = [];
  let index = startIndex;
  while (index < tokens.length && tokens[index].indent >= indent) {
    const token = tokens[index];
    if (token.indent !== indent || !token.content.startsWith('- ')) {
      throw contractError('malformed scalar sequence indentation', token.line);
    }
    const raw = token.content.slice(2).trim();
    if (findMappingColon(raw, token.line) >= 0) {
      throw contractError('sequence objects are unsupported for this field', token.line);
    }
    const value = parseScalar(raw, token.line);
    if (value !== null && typeof value !== 'string') {
      throw contractError('sequence items must be strings or null', token.line);
    }
    values.push(value);
    index += 1;
  }
  if (values.length === 0) throw contractError('expected a non-empty block sequence', fieldLine);
  return { values, nextIndex: index };
}

function knownString(value, field, lineNumber, { nullable = false } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw contractError(`${field} must be a${nullable ? ' string or null' : ' non-empty string'}`, lineNumber);
  }
  return value;
}

function parseCriterion(tokens, startIndex) {
  const start = tokens[startIndex];
  if (start.indent !== 2 || (start.content !== '-' && !start.content.startsWith('- '))) {
    throw contractError('criteria items must be mapping objects', start.line);
  }
  const values = {};
  const lines = {};
  const seen = new Set();
  let index = startIndex;
  const first = start.content.slice(1).trim();

  const acceptField = (token, mapping) => {
    const { key, rawValue } = mapping;
    if (seen.has(key)) throw contractError(`duplicate criterion key ${key}`, token.line);
    seen.add(key);
    lines[key] = token.line;
    const known = CRITERION_FIELDS.has(key);

    if (rawValue.startsWith('[')) {
      const sequence = parseInlineSequence(rawValue, token.line);
      if (known && key !== 'prerequisites') {
        throw contractError(`${key} must be a scalar`, token.line);
      }
      if (key === 'prerequisites') values[key] = sequence;
      return;
    }
    if (rawValue === '') {
      const nested = parseBlockSequence(tokens, index + 1, 6, token.line);
      if (known && key !== 'prerequisites') {
        throw contractError(`${key} must be a scalar`, token.line);
      }
      if (key === 'prerequisites') values[key] = nested.values;
      index = nested.nextIndex - 1;
      return;
    }
    if (key === 'prerequisites') {
      throw contractError('prerequisites must be a sequence', token.line);
    }
    const scalar = parseScalar(rawValue, token.line);
    if (known) values[key] = scalar;
  };

  if (first !== '') acceptField(start, parseMapping(first, start.line));
  index += 1;
  while (index < tokens.length && tokens[index].indent > 2) {
    const token = tokens[index];
    if (token.indent !== 4 || token.content.startsWith('- ')) {
      throw contractError('malformed criterion indentation', token.line);
    }
    acceptField(token, parseMapping(token.content, token.line));
    index += 1;
  }

  for (const field of REQUIRED_CRITERION) {
    if (!Object.hasOwn(values, field)) {
      throw contractError(`missing required criterion field ${field}`, start.line);
    }
  }
  const criterion = {
    id: knownString(values.id, 'id', lines.id),
    description: knownString(values.description, 'description', lines.description),
    verification: knownString(values.verification, 'verification', lines.verification),
    prerequisites: values.prerequisites,
    status: Object.hasOwn(values, 'status')
      ? knownString(values.status, 'status', lines.status, { nullable: true })
      : null,
    evidence: Object.hasOwn(values, 'evidence')
      ? knownString(values.evidence, 'evidence', lines.evidence, { nullable: true })
      : null,
  };
  if (!VERIFICATION_VALUES.has(criterion.verification)) {
    throw contractError('verification must be auto, manual, or mixed', lines.verification);
  }
  if (
    !Array.isArray(criterion.prerequisites)
    || criterion.prerequisites.some((item) => typeof item !== 'string' || item.length === 0)
  ) {
    throw contractError('prerequisites must be a sequence of non-empty strings', lines.prerequisites);
  }
  return { criterion, nextIndex: index };
}

function parseCriteria(tokens, startIndex, fieldLine) {
  const criteria = [];
  let index = startIndex;
  if (index >= tokens.length || tokens[index].indent <= 0) {
    throw contractError('criteria must be a sequence', fieldLine);
  }
  while (index < tokens.length && tokens[index].indent > 0) {
    if (tokens[index].indent !== 2) {
      throw contractError('malformed criteria indentation', tokens[index].line);
    }
    const parsed = parseCriterion(tokens, index);
    criteria.push(parsed.criterion);
    index = parsed.nextIndex;
  }
  return { criteria, nextIndex: index };
}

export function parseSprintContract(text) {
  if (typeof text !== 'string') throw new TypeError('contract text must be a string');
  const tokens = tokenize(text);
  const values = {};
  const lines = {};
  const seen = new Set();
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token.indent !== 0) throw contractError('top-level fields must not be indented', token.line);
    const { key, rawValue } = parseMapping(token.content, token.line);
    if (seen.has(key)) throw contractError(`duplicate top-level key ${key}`, token.line);
    seen.add(key);
    lines[key] = token.line;

    if (key === 'criteria') {
      if (rawValue === '[]') {
        values.criteria = [];
        index += 1;
        continue;
      }
      if (rawValue !== '') throw contractError('criteria must be a sequence', token.line);
      const parsed = parseCriteria(tokens, index + 1, token.line);
      values.criteria = parsed.criteria;
      index = parsed.nextIndex;
      continue;
    }

    if (rawValue === '') {
      if (TOP_LEVEL_FIELDS.has(key)) {
        throw contractError(`${key} must be a scalar`, token.line);
      }
      const sequence = parseBlockSequence(tokens, index + 1, 2, token.line);
      index = sequence.nextIndex;
      continue;
    }
    if (rawValue.startsWith('[')) {
      if (TOP_LEVEL_FIELDS.has(key)) throw contractError(`${key} must be a scalar`, token.line);
      parseInlineSequence(rawValue, token.line);
      index += 1;
      continue;
    }
    const scalar = parseScalar(rawValue, token.line);
    if (TOP_LEVEL_FIELDS.has(key)) values[key] = scalar;
    index += 1;
  }

  for (const field of REQUIRED_TOP_LEVEL) {
    if (!Object.hasOwn(values, field)) {
      throw contractError(`missing required field ${field}`, tokens[0]?.line ?? 1);
    }
  }
  const normalized = {
    slice: knownString(values.slice, 'slice', lines.slice),
    title: knownString(values.title, 'title', lines.title),
    source_plan: knownString(values.source_plan, 'source_plan', lines.source_plan),
    created_at: knownString(values.created_at, 'created_at', lines.created_at),
    status: Object.hasOwn(values, 'status')
      ? knownString(values.status, 'status', lines.status, { nullable: true })
      : null,
    criteria: values.criteria,
  };
  return normalized;
}

function fileFromArguments(argv) {
  let file;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--file') throw new Error(`unknown argument: ${argv[index]}`);
    if (argv[index + 1] === undefined) throw new Error('--file requires a value');
    file = argv[index + 1];
    index += 1;
  }
  if (!file) throw new Error('--file is required');
  return file;
}

export function runValidateContractCli(argv = process.argv.slice(2)) {
  try {
    const file = fileFromArguments(argv);
    const data = parseSprintContract(readFileSync(file, 'utf8'));
    process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  }
}

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) runValidateContractCli();
