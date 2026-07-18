import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseArtifactNames } from './release-artifacts.mjs';
import {
  createProvenanceRecord,
  serializeReleaseRecord,
  validatePackageInspection,
} from './release-provenance.mjs';

const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);

const inspectionFixture = Object.freeze({
  schemaVersion: 1,
  artifacts: [
    { kind: 'zip', name: 'Flasher-0.1.0-arm64-mac.zip', bytes: 200, sha256: digestB },
    { kind: 'dmg', name: 'Flasher-0.1.0-arm64.dmg', bytes: 100, sha256: digestA },
  ],
  application: {
    architecture: 'arm64',
    electron: '43.1.1',
    archiveSha256: 'c'.repeat(64),
    bundle: { identifier: 'com.physicistjohn.tinysa-flasher' },
    signature: {
      identifier: 'com.physicistjohn.tinysa-flasher',
      cdHash: 'deadbeef',
      signature: 'adhoc',
      teamIdentifier: 'not set',
      flags: ['runtime', 'adhoc'],
    },
    fuseStates: { runAsNode: false },
  },
});

const packageManifest = Object.freeze({
  name: 'tinysa-flasher',
  version: '0.1.0',
  packageManager: 'npm@10.9.8',
  devDependencies: { electron: '43.1.1' },
  build: {
    appId: 'com.physicistjohn.tinysa-flasher',
    asar: true,
    mac: {
      target: ['zip', 'dmg'], identity: '-', hardenedRuntime: true, gatekeeperAssess: false, minimumSystemVersion: '12.0',
    },
  },
});

test('provenance is deterministic, externally scoped, and explicitly makes no Developer ID/notarization claim', () => {
  const inspection = validatePackageInspection(inspectionFixture);
  const input = {
    commit: 'd'.repeat(40),
    hostArchitecture: 'arm64',
    node: '22.23.1',
    npm: '10.9.8',
    packageManifest,
    inspection,
  };
  const first = serializeReleaseRecord(createProvenanceRecord(input));
  const second = serializeReleaseRecord(createProvenanceRecord(input));

  assert.equal(first, second);
  const parsed = JSON.parse(first);
  assert.equal(parsed.source.tree, 'clean');
  assert.equal(parsed.application.artifactArchitecture, 'arm64');
  assert.deepEqual(parsed.toolchain, { node: '22.23.1', npm: '10.9.8', electron: '43.1.1' });
  assert.equal(parsed.packagingPolicy.developerIdApplication, 'not-used-or-claimed');
  assert.equal(parsed.packagingPolicy.notarization, 'not-requested-or-claimed');
  assert.equal(parsed.packagingPolicy.provenancePlacement, 'external-not-embedded');
  assert.equal(parsed.packagingPolicy.physicalHardwareQualification, 'not-performed-by-package-gate');
  assert.deepEqual(parsed.artifacts.map(({ name }) => name), [
    'Flasher-0.1.0-arm64.dmg',
    'Flasher-0.1.0-arm64-mac.zip',
  ]);
  assert.doesNotMatch(first, /timestamp|hostname|\/Users\//i);
});

test('inspection validation rejects any substituted publisher identity', () => {
  const substituted = structuredClone(inspectionFixture);
  substituted.application.signature.signature = 'Developer ID Application';
  substituted.application.signature.teamIdentifier = 'ABCDE12345';
  assert.throws(() => validatePackageInspection(substituted), /ad-hoc signature with no Team Identifier/);
});

test('checksum coverage is exactly one DMG, one ZIP, and both external records', () => {
  assert.deepEqual(releaseArtifactNames([
    'Flasher-0.1.0-arm64.dmg',
    'Flasher-0.1.0-arm64-mac.zip',
    'Flasher-0.1.0-arm64.dmg.blockmap',
    'PACKAGE-INSPECTION.json',
    'BUILD-PROVENANCE.json',
  ]), [
    'BUILD-PROVENANCE.json',
    'PACKAGE-INSPECTION.json',
    'Flasher-0.1.0-arm64-mac.zip',
    'Flasher-0.1.0-arm64.dmg',
  ]);
  assert.throws(() => releaseArtifactNames([
    'Flasher-0.1.0-arm64.dmg',
    'Flasher-0.1.0-arm64-mac.zip',
    'PACKAGE-INSPECTION.json',
  ]), /BUILD-PROVENANCE/);
});
