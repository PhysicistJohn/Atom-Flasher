#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// These ignored roots are either the installed lockfile-resolved dependency
// tree or outputs recreated by the automated check/package pipeline. Ignored
// environment files, firmware, journals, .dev state, logs, and every other path
// remain release blockers.
export const ALLOWED_RELEASE_IGNORED_ROOTS = Object.freeze([
  'coverage',
  'dist',
  'node_modules',
  'release',
]);

export function evaluateReleaseStatus(statusText) {
  const blockers = [];
  const allowedIgnored = [];
  for (const line of statusText.split('\n').filter(Boolean)) {
    if (line.length < 4 || line[2] !== ' ') {
      blockers.push(line);
      continue;
    }
    const status = line.slice(0, 2);
    const path = line.slice(3);
    if (status === '!!' && isAllowedIgnoredPath(path)) allowedIgnored.push(path);
    else blockers.push(line);
  }
  return Object.freeze({
    allowedIgnored: Object.freeze([...allowedIgnored].sort()),
    blockers: Object.freeze([...blockers].sort()),
  });
}

export async function assertCleanReleaseTree(root = defaultRoot) {
  const { stdout } = await execFileAsync('git', [
    '-C', root,
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--ignored=matching',
    '--ignore-submodules=none',
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const status = evaluateReleaseStatus(stdout);
  if (status.blockers.length > 0) {
    throw new Error(
      'Release packaging requires a clean tracked/untracked tree and permits ignored files only under '
      + `${ALLOWED_RELEASE_IGNORED_ROOTS.join(', ')}. Blockers:\n${status.blockers.join('\n')}`,
    );
  }
  const commitResult = await execFileAsync('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' });
  const commit = commitResult.stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error(`Could not resolve an exact release commit: ${commit}`);
  return Object.freeze({ commit, allowedIgnored: status.allowedIgnored });
}

export async function beginRelease(root = defaultRoot) {
  const clean = await assertCleanReleaseTree(root);
  const path = await releaseSessionPath(root);
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, `${clean.commit}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return clean;
}

export async function assertReleaseCheckpoint(root = defaultRoot) {
  const clean = await assertCleanReleaseTree(root);
  const expected = await readReleaseSessionCommit(root, true);
  if (clean.commit !== expected) {
    throw new Error(`Release source changed after admission: expected ${expected}, received ${clean.commit}`);
  }
  return clean;
}

export async function finishRelease(root = defaultRoot) {
  const clean = await assertReleaseCheckpoint(root);
  await rm(await releaseSessionPath(root), { force: true });
  return clean;
}

export async function optionalReleaseSessionCommit(root = defaultRoot) {
  return readReleaseSessionCommit(root, false);
}

function isAllowedIgnoredPath(path) {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
  const normalized = path.endsWith('/') ? path.slice(0, -1) : path;
  return ALLOWED_RELEASE_IGNORED_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

async function readReleaseSessionCommit(root, required) {
  const path = await releaseSessionPath(root);
  let value;
  try {
    value = (await readFile(path, 'utf8')).trim();
  } catch (error) {
    if (!required && error?.code === 'ENOENT') return undefined;
    if (error?.code === 'ENOENT') throw new Error('No admitted release session exists; run the release begin gate first');
    throw error;
  }
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error(`Malformed admitted release commit: ${value}`);
  return value;
}

async function releaseSessionPath(root) {
  const { stdout } = await execFileAsync('git', ['-C', root, 'rev-parse', '--git-path', 'tinysa-flasher-release-commit'], { encoding: 'utf8' });
  const value = stdout.trim();
  if (!value) throw new Error('Git returned an empty release-session path');
  return isAbsolute(value) ? value : resolve(root, value);
}

async function main() {
  const command = process.argv[2];
  if (process.argv.length !== 3 || !['assert-clean', 'begin', 'checkpoint', 'finish'].includes(command)) {
    process.stderr.write('Usage: node tools/release-gate.mjs assert-clean|begin|checkpoint|finish\n');
    process.exitCode = 2;
    return;
  }
  const result = command === 'begin' ? await beginRelease()
    : command === 'checkpoint' ? await assertReleaseCheckpoint()
      : command === 'finish' ? await finishRelease()
        : await assertCleanReleaseTree();
  process.stdout.write(
    `Release ${command} gate is clean at ${result.commit}; ignored paths are confined to generated/dependency roots`
    + `${result.allowedIgnored.length ? ` (${result.allowedIgnored.join(', ')})` : ''}.\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
