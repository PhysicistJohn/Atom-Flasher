#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RELEASE_RECORD_NAMES } from './release-provenance.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDirectory = resolve(root, 'release');
const checksumPath = resolve(releaseDirectory, 'SHA256SUMS');

async function writeChecksums() {
  const artifacts = await distributionArtifacts();
  const lines = [];
  for (const artifact of artifacts) lines.push(`${await hashFile(resolve(releaseDirectory, artifact))}  ${artifact}`);
  const temporary = `${checksumPath}.tmp-${process.pid}`;
  await writeFile(temporary, `${lines.join('\n')}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
  await rename(temporary, checksumPath);
  process.stdout.write(`Wrote release/SHA256SUMS for ${artifacts.length} distribution artifacts and external provenance records.\n`);
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
    throw new Error(`SHA256SUMS does not exactly cover the DMG/ZIP artifacts and provenance records (${artifacts.join(', ')})`);
  }
  for (const artifact of artifacts) {
    const actual = await hashFile(resolve(releaseDirectory, artifact));
    if (actual !== expected.get(artifact)) throw new Error(`Checksum mismatch for ${artifact}: expected ${expected.get(artifact)}, received ${actual}`);
  }
  process.stdout.write(`Verified ${artifacts.length} release artifact/provenance checksums.\n`);
}

async function distributionArtifacts() {
  const entries = await readdir(releaseDirectory, { withFileTypes: true });
  return releaseArtifactNames(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
}

export function releaseArtifactNames(fileNames) {
  const dmgs = fileNames.filter((name) => name.endsWith('.dmg'));
  const zips = fileNames.filter((name) => name.endsWith('.zip'));
  if (dmgs.length !== 1 || zips.length !== 1) {
    throw new Error(`Expected exactly one DMG and one ZIP in release/, found ${dmgs.length} DMG and ${zips.length} ZIP`);
  }
  for (const record of RELEASE_RECORD_NAMES) {
    if (!fileNames.includes(record)) throw new Error(`Expected release/${record} before writing checksums`);
  }
  return [...dmgs, ...zips, ...RELEASE_RECORD_NAMES].sort();
}

async function hashFile(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

async function main() {
  const command = process.argv[2];
  if (process.argv.length !== 3 || !['write', 'verify'].includes(command)) {
    process.stderr.write('Usage: node tools/release-artifacts.mjs write|verify\n');
    process.exitCode = 2;
  } else if (command === 'write') await writeChecksums();
  else await verifyChecksums();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
