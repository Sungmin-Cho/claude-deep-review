#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildChangeFiles,
  serializeChangeFiles,
} from './lib/review-target.mjs';

function parseArguments(argv) {
  const options = { repo: '.' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    switch (argument) {
      case '--repo':
        options.repo = value;
        index += 1;
        break;
      case '--change-state':
        options.changeState = value;
        index += 1;
        break;
      case '--review-base':
        options.reviewBase = value;
        index += 1;
        break;
      case '--files-from-z':
        options.filesFromZ = value;
        index += 1;
        break;
      case '--max-entries':
        options.maxEntries = value;
        index += 1;
        break;
      case '--max-bytes':
        options.maxBytes = value;
        index += 1;
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
    if (value === undefined) throw new Error(`${argument} requires a value`);
  }
  options.maxEntries ??= process.env.OCR_CHANGE_FILES_MAX_ENTRIES;
  options.maxBytes ??= process.env.OCR_CHANGE_FILES_MAX_BYTES;
  return options;
}

export function runBuildChangeFilesCli(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const records = buildChangeFiles(options);
  process.stdout.write(serializeChangeFiles(records));
}

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  try {
    runBuildChangeFilesCli();
  } catch (error) {
    process.stderr.write(`build-change-files: ${error.message}\n`);
    process.exitCode = 2;
  }
}
