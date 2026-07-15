#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { assertCleanReleaseTree, optionalReleaseSessionCommit } from './release-gate.mjs';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDirectory = resolve(root, 'release');
const inspectionPath = resolve(releaseDirectory, 'PACKAGE-INSPECTION.json');
const provenancePath = resolve(releaseDirectory, 'BUILD-PROVENANCE.json');

export const RELEASE_RECORD_NAMES = Object.freeze([
  'BUILD-PROVENANCE.json',
  'PACKAGE-INSPECTION.json',
]);

export function validatePackageInspection(value) {
  assertExactKeys(value, ['application', 'artifacts', 'schemaVersion'], 'package inspection');
  if (value.schemaVersion !== 1) throw new Error('Package inspection schemaVersion must be 1');
  if (!Array.isArray(value.artifacts) || value.artifacts.length !== 2) {
    throw new Error('Package inspection must describe exactly one DMG and one ZIP');
  }
  const artifacts = value.artifacts.map((artifact, index) => validateArtifact(artifact, index));
  if (artifacts.map(({ kind }) => kind).sort().join(',') !== 'dmg,zip') {
    throw new Error('Package inspection artifact kinds must be exactly dmg and zip');
  }

  assertExactKeys(value.application, [
    'architecture', 'archiveSha256', 'bundle', 'electron', 'fuseStates', 'signature',
  ], 'package inspection application');
  const application = value.application;
  if (!['arm64', 'x64'].includes(application.architecture)) {
    throw new Error(`Unsupported packaged application architecture: ${String(application.architecture)}`);
  }
  if (typeof application.electron !== 'string' || !/^\d+\.\d+\.\d+$/.test(application.electron)) {
    throw new Error(`Invalid packaged Electron version: ${String(application.electron)}`);
  }
  if (typeof application.archiveSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(application.archiveSha256)) {
    throw new Error('Package inspection has an invalid ASAR SHA-256');
  }
  assertRecord(application.bundle, 'package inspection bundle');
  assertRecord(application.fuseStates, 'package inspection fuse states');
  assertExactKeys(application.signature, [
    'cdHash', 'flags', 'identifier', 'signature', 'teamIdentifier',
  ], 'package inspection signature');
  const signature = application.signature;
  if (typeof signature.identifier !== 'string' || !signature.identifier) throw new Error('Package inspection is missing a signing identifier');
  if (typeof signature.cdHash !== 'string' || !/^[a-f0-9]+$/.test(signature.cdHash)) throw new Error('Package inspection has an invalid CDHash');
  if (signature.signature !== 'adhoc' || signature.teamIdentifier !== 'not set') {
    throw new Error('Package inspection must prove an ad-hoc signature with no Team Identifier');
  }
  if (!Array.isArray(signature.flags)
    || signature.flags.some((flag) => typeof flag !== 'string')
    || !signature.flags.includes('adhoc')
    || !signature.flags.includes('runtime')) {
    throw new Error('Package inspection must prove ad-hoc and hardened-runtime CodeDirectory flags');
  }
  return Object.freeze({
    schemaVersion: 1,
    artifacts: Object.freeze([...artifacts].sort((left, right) => artifactKindOrder(left.kind) - artifactKindOrder(right.kind))),
    application,
  });
}

export function createProvenanceRecord({ commit, hostArchitecture, node, npm, packageManifest, inspection }) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error(`Invalid source commit: ${commit}`);
  if (!['arm64', 'x64'].includes(hostArchitecture)) throw new Error(`Unsupported host architecture: ${hostArchitecture}`);
  if (inspection.application.architecture !== hostArchitecture) {
    throw new Error(`Current-host package architecture ${inspection.application.architecture} does not match Node host ${hostArchitecture}`);
  }
  const expectedElectron = packageManifest.devDependencies?.electron;
  if (inspection.application.electron !== expectedElectron) {
    throw new Error(`Packaged Electron ${inspection.application.electron} does not match locked manifest ${String(expectedElectron)}`);
  }
  const targets = [...(packageManifest.build?.mac?.target ?? [])].sort();
  if (targets.join(',') !== 'dmg,zip'
    || typeof packageManifest.build?.appId !== 'string'
    || !packageManifest.build.appId
    || packageManifest.build?.asar !== true
    || typeof packageManifest.build?.mac?.minimumSystemVersion !== 'string'
    || packageManifest.build?.mac?.identity !== '-'
    || packageManifest.build?.mac?.hardenedRuntime !== true
    || packageManifest.build?.mac?.gatekeeperAssess !== false) {
    throw new Error('The local macOS packaging policy must remain DMG+ZIP, ad-hoc, hardened-runtime, and without Gatekeeper assessment claims');
  }
  const expectedNpm = packageManifest.packageManager?.match(/^npm@(\d+\.\d+\.\d+)$/)?.[1];
  if (npm !== expectedNpm) throw new Error(`npm ${npm} does not match packageManager npm@${String(expectedNpm)}`);

  return Object.freeze({
    schemaVersion: 1,
    format: 'tinysa-flasher-local-package-provenance',
    source: Object.freeze({ commit, tree: 'clean' }),
    application: Object.freeze({
      name: packageManifest.name,
      version: packageManifest.version,
      hostArchitecture,
      artifactArchitecture: inspection.application.architecture,
    }),
    toolchain: Object.freeze({ node, npm, electron: inspection.application.electron }),
    packagingPolicy: Object.freeze({
      scope: 'local-ci-automated-software-gates-only',
      applicationId: packageManifest.build.appId,
      minimumSystemVersion: packageManifest.build.mac.minimumSystemVersion,
      archive: 'asar-required',
      targets: Object.freeze(targets),
      architecture: 'current-host',
      provenancePlacement: 'external-not-embedded',
      checksumCoverage: 'dmg-zip-package-inspection-build-provenance',
      applicationSigning: 'ad-hoc-hardened-runtime',
      developerIdApplication: 'not-used-or-claimed',
      notarization: 'not-requested-or-claimed',
      stapling: 'not-requested-or-claimed',
      gatekeeperAssessment: 'not-performed-or-claimed',
      physicalHardwareQualification: 'not-performed-by-package-gate',
    }),
    observedApplication: Object.freeze({
      archiveSha256: inspection.application.archiveSha256,
      signing: Object.freeze({
        kind: inspection.application.signature.signature,
        identifier: inspection.application.signature.identifier,
        cdHash: inspection.application.signature.cdHash,
        teamIdentifier: inspection.application.signature.teamIdentifier,
        codeDirectoryFlags: Object.freeze([...inspection.application.signature.flags].sort()),
      }),
      fuseStates: inspection.application.fuseStates,
    }),
    artifacts: Object.freeze(inspection.artifacts.map((artifact) => Object.freeze({ ...artifact }))),
  });
}

export function serializeReleaseRecord(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function expectedProvenance() {
  if (process.platform !== 'darwin') throw new Error('macOS package provenance can be generated only on macOS');
  const clean = await assertCleanReleaseTree(root);
  const admittedCommit = await optionalReleaseSessionCommit(root);
  if (admittedCommit !== undefined && clean.commit !== admittedCommit) {
    throw new Error(`Release source changed after admission: expected ${admittedCommit}, received ${clean.commit}`);
  }
  const packageManifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const expectedNode = (await readFile(resolve(root, '.node-version'), 'utf8')).trim();
  if (process.versions.node !== expectedNode) {
    throw new Error(`Node ${process.versions.node} does not match .node-version ${expectedNode}`);
  }
  const npm = await currentNpmVersion();
  const inspection = validatePackageInspection(JSON.parse(await readFile(inspectionPath, 'utf8')));
  await verifyInspectionArtifacts(inspection);
  return createProvenanceRecord({
    commit: clean.commit,
    hostArchitecture: process.arch,
    node: process.versions.node,
    npm,
    packageManifest,
    inspection,
  });
}

async function writeProvenance() {
  const record = await expectedProvenance();
  await atomicWrite(provenancePath, serializeReleaseRecord(record));
  process.stdout.write(`Wrote deterministic external provenance to release/${basename(provenancePath)} for ${record.artifacts.length} artifacts.\n`);
}

async function verifyProvenance() {
  const expected = serializeReleaseRecord(await expectedProvenance());
  const actual = await readFile(provenancePath, 'utf8');
  if (actual !== expected) throw new Error('BUILD-PROVENANCE.json does not exactly match the clean source, toolchain, package inspection, policy, and artifact bytes');
  process.stdout.write('Verified deterministic build provenance, artifact hashes, and truthful local ad-hoc signing policy.\n');
}

async function verifyInspectionArtifacts(inspection) {
  for (const artifact of inspection.artifacts) {
    const path = resolve(releaseDirectory, artifact.name);
    if (dirname(path) !== releaseDirectory) throw new Error(`Unsafe inspected artifact path: ${artifact.name}`);
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size !== artifact.bytes) {
      throw new Error(`Inspected artifact size mismatch for ${artifact.name}`);
    }
    const digest = await sha256File(path);
    if (digest !== artifact.sha256) throw new Error(`Inspected artifact digest mismatch for ${artifact.name}`);
  }
}

async function currentNpmVersion() {
  const command = process.env.npm_execpath ? process.execPath : 'npm';
  const args = process.env.npm_execpath ? [process.env.npm_execpath, '--version'] : ['--version'];
  const { stdout } = await execFileAsync(command, args, { encoding: 'utf8' });
  return stdout.trim();
}

function validateArtifact(value, index) {
  assertExactKeys(value, ['bytes', 'kind', 'name', 'sha256'], `package inspection artifact ${index}`);
  if (!['dmg', 'zip'].includes(value.kind)) throw new Error(`Invalid package artifact kind: ${String(value.kind)}`);
  if (typeof value.name !== 'string' || basename(value.name) !== value.name || !value.name.endsWith(`.${value.kind}`)) {
    throw new Error(`Unsafe package artifact name: ${String(value.name)}`);
  }
  if (!Number.isSafeInteger(value.bytes) || value.bytes <= 0) throw new Error(`Invalid package artifact size: ${String(value.bytes)}`);
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error(`Invalid package artifact SHA-256: ${String(value.sha256)}`);
  return Object.freeze({ kind: value.kind, name: value.name, bytes: value.bytes, sha256: value.sha256 });
}

function artifactKindOrder(kind) {
  return kind === 'dmg' ? 0 : 1;
}

function assertExactKeys(value, keys, label) {
  assertRecord(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.join(',') !== expected.join(',')) {
    throw new Error(`${label} keys ${JSON.stringify(actual)} do not match ${JSON.stringify(expected)}`);
  }
}

function assertRecord(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function atomicWrite(path, contents) {
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function main() {
  const command = process.argv[2];
  if (process.argv.length !== 3 || !['write', 'verify'].includes(command)) {
    process.stderr.write('Usage: node tools/release-provenance.mjs write|verify\n');
    process.exitCode = 2;
  } else if (command === 'write') await writeProvenance();
  else await verifyProvenance();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
