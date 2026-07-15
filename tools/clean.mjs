#!/usr/bin/env node

import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const groups = Object.freeze({
  all: ['coverage', 'dist', 'release'],
  dist: ['dist'],
  release: ['release'],
});

const selection = process.argv[2] ?? 'all';
const names = groups[selection];
if (!names) {
  process.stderr.write(`Usage: node tools/clean.mjs ${Object.keys(groups).join('|')}\n`);
  process.exitCode = 2;
} else {
  for (const name of names) {
    const path = resolve(root, name);
    if (dirname(path) !== root) throw new Error(`Refusing to clean outside the repository: ${path}`);
    await rm(path, { force: true, recursive: true });
    process.stdout.write(`Removed ${name}/\n`);
  }
}
