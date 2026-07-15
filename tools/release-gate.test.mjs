import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  assertCleanReleaseTree,
  assertReleaseCheckpoint,
  beginRelease,
  evaluateReleaseStatus,
  finishRelease,
} from './release-gate.mjs';

const execFileAsync = promisify(execFile);

test('status policy permits only the four declared ignored roots', () => {
  assert.deepEqual(evaluateReleaseStatus([
    '!! coverage/',
    '!! dist/',
    '!! node_modules/',
    '!! release/',
    '!! release/nested/output.dmg',
    '?? scratch.txt',
    ' M tracked.txt',
    '!! .env',
    '!! .dev/',
    '!! custom.bin',
  ].join('\n')), {
    allowedIgnored: ['coverage/', 'dist/', 'node_modules/', 'release/', 'release/nested/output.dmg'],
    blockers: [' M tracked.txt', '!! .dev/', '!! .env', '!! custom.bin', '?? scratch.txt'],
  });
});

test('Git-backed release gate rejects tracked, untracked, and non-output ignored state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tinysa-flasher-release-gate-'));
  try {
    await git(directory, ['init', '-q']);
    await git(directory, ['config', 'user.name', 'Release Gate Test']);
    await git(directory, ['config', 'user.email', 'release-gate@example.invalid']);
    await writeFile(join(directory, '.gitignore'), [
      'coverage/', 'dist/', 'node_modules/', 'release/', '.dev/', '.env', '*.bin', '',
    ].join('\n'));
    await writeFile(join(directory, 'tracked.txt'), 'committed\n');
    await git(directory, ['add', '.gitignore', 'tracked.txt']);
    await git(directory, ['commit', '-q', '-m', 'fixture']);
    for (const root of ['coverage', 'dist', 'node_modules', 'release']) {
      await mkdir(join(directory, root), { recursive: true });
      await writeFile(join(directory, root, 'generated.txt'), 'generated\n');
    }

    const clean = await assertCleanReleaseTree(directory);
    assert.match(clean.commit, /^[a-f0-9]{40}$/);
    assert.deepEqual(clean.allowedIgnored, ['coverage/', 'dist/', 'node_modules/', 'release/']);

    const admitted = await beginRelease(directory);
    assert.equal((await assertReleaseCheckpoint(directory)).commit, admitted.commit);
    await writeFile(join(directory, 'tracked.txt'), 'next committed source\n');
    await git(directory, ['add', 'tracked.txt']);
    await git(directory, ['commit', '-q', '-m', 'source changed']);
    await assert.rejects(assertReleaseCheckpoint(directory), /Release source changed after admission/);
    const readmitted = await beginRelease(directory);
    assert.notEqual(readmitted.commit, admitted.commit);
    assert.equal((await finishRelease(directory)).commit, readmitted.commit);
    await assert.rejects(assertReleaseCheckpoint(directory), /No admitted release session exists/);

    await writeFile(join(directory, 'scratch.txt'), 'untracked\n');
    await assert.rejects(assertCleanReleaseTree(directory), /\?\? scratch\.txt/);
    await unlink(join(directory, 'scratch.txt'));

    await writeFile(join(directory, 'tracked.txt'), 'dirty\n');
    await assert.rejects(assertCleanReleaseTree(directory), /tracked\.txt/);
    await git(directory, ['checkout', '--', 'tracked.txt']);

    await writeFile(join(directory, '.env'), 'SECRET=not-a-release-input\n');
    await assert.rejects(assertCleanReleaseTree(directory), /!! \.env/);
    await unlink(join(directory, '.env'));

    await mkdir(join(directory, '.dev'), { recursive: true });
    await writeFile(join(directory, '.dev', 'state.json'), '{}\n');
    await assert.rejects(assertCleanReleaseTree(directory), /!! \.dev\//);
    await rm(join(directory, '.dev'), { force: true, recursive: true });

    await writeFile(join(directory, 'unreviewed.bin'), 'firmware\n');
    await assert.rejects(assertCleanReleaseTree(directory), /!! unreviewed\.bin/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

async function git(directory, args) {
  await execFileAsync('git', ['-C', directory, ...args], { encoding: 'utf8' });
}
