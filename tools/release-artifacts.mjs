#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDirectory = resolve(root, 'release');
const checksumPath = resolve(releaseDirectory, 'SHA256SUMS');
const command = process.argv[2];

if (command === 'write') await writeChecksums();
else if (command === 'verify') await verifyChecksums();
else {
  process.stderr.write('Usage: node tools/release-artifacts.mjs write|verify\n');
  process.exitCode = 2;
}

async function writeChecksums() {
  const artifacts = await distributionArtifacts();
  const lines = [];
  for (const artifact of artifacts) lines.push(`${await hashFile(resolve(releaseDirectory, artifact))}  ${artifact}`);
  const temporary = `${checksumPath}.tmp-${process.pid}`;
  await writeFile(temporary, `${lines.join('\n')}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
  await rename(temporary, checksumPath);
  process.stdout.write(`Wrote release/SHA256SUMS for ${artifacts.length} distribution artifacts.\n`);
}

async function verifyChecksums() {
  const artifacts = await distributionArtifacts();
  const text = await readFile(checksumPath, 'utf8');
  const expected = new Map();
  for (const line of text.trimEnd().split('\n')) {
    const match = /^([a-f0-9]{64}) {2}([^/\n]+)$/.exec(line);
    if (!match) throw new Error(`Invalid SHA256SUMS line: ${line}`);
    const [, digest, name] = match;
    if (basename(name) !== name || expected.has(name)) throw new Error(`Unsafe or duplicate artifact name: ${name}`);
    expected.set(name, digest);
  }
  if (expected.size !== artifacts.length || artifacts.some((name) => !expected.has(name))) {
    throw new Error(`SHA256SUMS does not exactly cover the DMG/ZIP artifacts (${artifacts.join(', ')})`);
  }
  for (const artifact of artifacts) {
    const actual = await hashFile(resolve(releaseDirectory, artifact));
    if (actual !== expected.get(artifact)) throw new Error(`Checksum mismatch for ${artifact}: expected ${expected.get(artifact)}, received ${actual}`);
  }
  process.stdout.write(`Verified ${artifacts.length} release artifact checksums.\n`);
}

async function distributionArtifacts() {
  const entries = await readdir(releaseDirectory, { withFileTypes: true });
  const artifacts = entries
    .filter((entry) => entry.isFile() && /\.(?:dmg|zip)$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (!artifacts.some((name) => name.endsWith('.dmg')) || !artifacts.some((name) => name.endsWith('.zip'))) {
    throw new Error('Expected at least one DMG and one ZIP in release/');
  }
  return artifacts;
}

async function hashFile(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
