/**
 * Pins the firmware digest chain: the pinned OEM sha256/size verification
 * rejects any mismatch, a tampered download is never installed at the
 * canonical path, and custom-target admission enforces the manifest sha256.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { OEM_ZS407_FIRMWARE_RELEASE } from '../src/core/contracts.js';
import { FirmwareArtifactStore, verifyFirmwareArtifact } from '../src/core/firmware-artifact.js';
import { FirmwareUpdater } from '../src/core/firmware-updater.js';
import {
  FakeFirmwareDevice,
  customArtifactFixture,
  fakeVerifiedArtifact,
  removeTemporaryDirectories,
  runtimeFixture,
  successfulTransfer,
  temporaryDirectory,
} from './helpers.js';

afterEach(removeTemporaryDirectories);

describe('safety chain: pinned OEM sha verification', () => {
  it('rejects a wrong length before hashing', () => {
    expect(() => verifyFirmwareArtifact(new Uint8Array(10)))
      .toThrow(new RegExp(`has 10 bytes, expected ${OEM_ZS407_FIRMWARE_RELEASE.sizeBytes}`));
  });

  it('rejects exact-length bytes whose sha256 does not match the pin', () => {
    const bytes = new Uint8Array(OEM_ZS407_FIRMWARE_RELEASE.sizeBytes).fill(0x5a);
    const actual = createHash('sha256').update(bytes).digest('hex');
    expect(actual).not.toBe(OEM_ZS407_FIRMWARE_RELEASE.sha256);
    expect(() => verifyFirmwareArtifact(bytes)).toThrow(/SHA-256 .* does not match pinned/i);
  });

  it('never installs a tampered download at the canonical path', async () => {
    const directory = await temporaryDirectory();
    const tampered = new Uint8Array(OEM_ZS407_FIRMWARE_RELEASE.sizeBytes).fill(0x5a);
    const store = new FirmwareArtifactStore(directory, {
      fetch: async () => new Response(tampered.slice().buffer, {
        status: 200,
        headers: { 'content-length': String(tampered.byteLength) },
      }),
      verify: verifyFirmwareArtifact,
      now: () => new Date(),
      randomUuid: () => randomUUID(),
    });

    await expect(store.download()).rejects.toThrow(/SHA-256 .* does not match pinned/i);
    await expect(stat(store.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(directory)).filter((name) => name.endsWith('.bin'))).toEqual([]);
  });
});

describe('safety chain: custom-target sha admission', () => {
  it('rejects an admitted custom artifact whose sha256 does not match the manifest', async () => {
    const directory = await temporaryDirectory();
    const fixture = customArtifactFixture();
    const corrupted = fixture.bytes.slice();
    corrupted[100] = corrupted[100]! ^ 1;
    const updater = new FirmwareUpdater(directory, new FakeFirmwareDevice(), runtimeFixture(async () => successfulTransfer()));
    await updater.state();

    await expect(updater.admitLocalCustomTarget(fixture.target, Object.freeze({
      targetId: fixture.target.targetId,
      openVerified: async () => fakeVerifiedArtifact(corrupted),
    }))).rejects.toThrow(/SHA-256 .* does not match manifest/i);
  });

  it('admits a custom artifact with a computable matching sha256', async () => {
    const directory = await temporaryDirectory();
    const fixture = customArtifactFixture();
    const updater = new FirmwareUpdater(directory, new FakeFirmwareDevice(), runtimeFixture(async () => successfulTransfer()));
    await updater.state();

    await expect(updater.admitLocalCustomTarget(fixture.target, fixture.artifact)).resolves.toMatchObject({
      phase: 'verified',
      target: { kind: 'local-custom', targetId: fixture.target.targetId },
      artifact: { sha256: fixture.target.sha256, sizeBytes: fixture.bytes.byteLength },
    });
  });
});
