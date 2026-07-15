import { createHash, randomUUID } from 'node:crypto';
import { readSync } from 'node:fs';
import { chmod, mkdtemp, readFile, readdir, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LocalFirmwareBuildStore,
  localCustomTargetForBuild,
  localFirmwareBuildManifestSchema,
  type LocalFirmwareBuildManifest,
} from '../src/core/local-firmware-build.js';

const directories: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('local ZS407 firmware build admission', () => {
  it('admits one exact manifested image into create-once application-owned storage', async () => {
    const source = await temporaryDirectory();
    const owned = await temporaryDirectory();
    const bytes = firmwareBytes();
    const manifest = manifestFor(bytes);
    const manifestPath = await writeBuild(source, bytes, manifest);
    const clock = new Date('2026-07-14T20:00:00.000Z');
    const store = new LocalFirmwareBuildStore(owned, { now: () => clock, randomUuid: randomUUID });

    const imported = await store.importManifest(manifestPath);

    expect(imported).toMatchObject({ manifest, importedAt: clock.toISOString() });
    expect(imported.artifactPath).toContain(manifest.artifact.sha256);
    expect(localCustomTargetForBuild(imported)).toMatchObject({
      kind: 'local-custom',
      targetId: `custom-zs407-${manifest.artifact.sha256}`,
      version: manifest.firmware.version,
      revision: manifest.firmware.reportedRevision,
      manifestSha256: imported.manifestSha256,
      hardwareQualification: 'unqualified',
      transportIntegrity: 'local-manifest-sha256',
    });
    expect(new Uint8Array(await readFile(imported.artifactPath))).toEqual(bytes);
    expect(await store.readVerified(imported)).toEqual(bytes);
    const verified = await store.openVerified(imported);
    try {
      const vector = Buffer.alloc(8);
      expect(readSync(verified.descriptor, vector, 0, vector.byteLength, null)).toBe(8);
      expect(new Uint8Array(vector)).toEqual(bytes.slice(0, 8));
    } finally {
      await verified.close();
    }
    expect((await store.importManifest(manifestPath)).artifactPath).toBe(imported.artifactPath);
    expect(Object.isFrozen(imported)).toBe(true);
    expect(Object.isFrozen(imported.manifest.artifact)).toBe(true);

    const reopened = await store.reopenTarget(localCustomTargetForBuild(imported));
    expect(localCustomTargetForBuild(reopened)).toEqual(localCustomTargetForBuild(imported));
    expect(await store.readVerified(reopened)).toEqual(bytes);
  });

  it('rejects malformed provenance and qualification claims before reading a target', () => {
    const bytes = firmwareBytes();
    const valid = manifestFor(bytes);
    expect(() => localFirmwareBuildManifestSchema.parse({
      ...valid,
      firmware: { ...valid.firmware, reportedRevision: '7654321' },
    })).toThrow(/version suffix/i);
    expect(() => localFirmwareBuildManifestSchema.parse({
      ...valid,
      firmware: { ...valid.firmware, sourceTree: 'dirty' },
    })).toThrow();
    expect(() => localFirmwareBuildManifestSchema.parse({
      ...valid,
      build: { ...valid.build, qualificationEvidenceSha256: 'a'.repeat(64) },
    })).toThrow(/unqualified/i);
  });

  it('retains the exact qualification-evidence digest in a qualified target', async () => {
    const source = await temporaryDirectory();
    const owned = await temporaryDirectory();
    const bytes = firmwareBytes();
    const qualificationEvidenceSha256 = 'f'.repeat(64);
    const base = manifestFor(bytes);
    const manifest = localFirmwareBuildManifestSchema.parse({
      ...base,
      build: {
        ...base.build,
        hardwareQualification: 'qualified-on-zs407',
        qualificationEvidenceSha256,
      },
    });
    const imported = await new LocalFirmwareBuildStore(owned).importManifest(await writeBuild(source, bytes, manifest));

    expect(localCustomTargetForBuild(imported)).toMatchObject({
      hardwareQualification: 'qualified',
      qualificationEvidenceSha256,
    });
  });

  it('rejects symlinked manifests and artifacts', async () => {
    const source = await temporaryDirectory();
    const owned = await temporaryDirectory();
    const bytes = firmwareBytes();
    const manifest = manifestFor(bytes);
    const manifestPath = await writeBuild(source, bytes, manifest);
    const linkedManifest = join(source, 'linked.json');
    await symlink(manifestPath, linkedManifest);
    await expect(new LocalFirmwareBuildStore(owned).importManifest(linkedManifest)).rejects.toThrow();

    const second = await temporaryDirectory();
    const actualArtifact = join(second, 'actual.bin');
    await writeFile(actualArtifact, bytes, { mode: 0o600 });
    await symlink(actualArtifact, join(second, manifest.artifact.filename));
    await writeFile(join(second, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
    await expect(new LocalFirmwareBuildStore(owned).importManifest(join(second, 'manifest.json'))).rejects.toThrow();
  });

  it('bounds a selected source file that grows after its opened size is checked', async () => {
    const source = await temporaryDirectory();
    const owned = await temporaryDirectory();
    const bytes = firmwareBytes();
    const manifestPath = await writeBuild(source, bytes, manifestFor(bytes));
    let raced = false;
    const store = new LocalFirmwareBuildStore(owned, undefined, {
      afterSourceStat: async (path) => {
        if (path !== manifestPath || raced) return;
        raced = true;
        await truncate(path, 64 * 1024 + 1);
      },
    });

    await expect(store.importManifest(manifestPath)).rejects.toThrow(/became longer while it was being read/i);
    expect(raced).toBe(true);
  });

  it('rejects writable-by-group input, digest drift, vector drift, and missing embedded identity', async () => {
    const owned = await temporaryDirectory();
    const groupWritable = await temporaryDirectory();
    const bytes = firmwareBytes();
    const manifest = manifestFor(bytes);
    const groupManifest = await writeBuild(groupWritable, bytes, manifest);
    if (process.platform !== 'win32') {
      await chmod(groupManifest, 0o660);
      await expect(new LocalFirmwareBuildStore(owned).importManifest(groupManifest)).rejects.toThrow(/writable by another/i);
    }

    for (const mutate of [
      (value: Uint8Array) => { value[500] = value[500]! ^ 1; },
      (value: Uint8Array) => { new DataView(value.buffer).setUint32(4, 0x0800_1000, true); },
      (value: Uint8Array) => { value.fill(0, 100, 100 + manifest.firmware.version.length); },
    ]) {
      const source = await temporaryDirectory();
      const changed = bytes.slice();
      mutate(changed);
      const path = await writeBuild(source, changed, manifest);
      await expect(new LocalFirmwareBuildStore(owned).importManifest(path)).rejects.toThrow();
    }
  });

  it('retains and rejects a conflicting create-once destination', async () => {
    const source = await temporaryDirectory();
    const owned = await temporaryDirectory();
    const bytes = firmwareBytes();
    const manifest = manifestFor(bytes);
    const manifestPath = await writeBuild(source, bytes, manifest);
    const collisionDirectory = join(owned, 'custom-artifacts-v1');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(collisionDirectory, { recursive: true, mode: 0o700 });
    const collision = Uint8Array.of(1, 2, 3);
    await writeFile(join(collisionDirectory, `${manifest.artifact.sha256}.bin`), collision, { mode: 0o600 });

    await expect(new LocalFirmwareBuildStore(owned).importManifest(manifestPath)).rejects.toThrow(/collision/i);
    expect(new Uint8Array(await readFile(join(collisionDirectory, `${manifest.artifact.sha256}.bin`)))).toEqual(collision);
  });

  it('retains the fsynced staging link when final-name directory durability is uncertain', async () => {
    const source = await temporaryDirectory();
    const owned = await temporaryDirectory();
    const bytes = firmwareBytes();
    const manifest = manifestFor(bytes);
    const manifestPath = await writeBuild(source, bytes, manifest);
    const durableFiles = await import('../src/core/persistence/durable-files.js');
    const sync = vi.spyOn(durableFiles, 'syncDirectory').mockRejectedValueOnce(new Error('forced directory sync failure'));
    try {
      await expect(new LocalFirmwareBuildStore(owned).importManifest(manifestPath)).rejects.toThrow(/forced directory sync failure/i);
    } finally {
      sync.mockRestore();
    }

    const entries = await readdir(join(owned, 'custom-artifacts-v1'));
    expect(entries).toContain(`${manifest.artifact.sha256}.bin`);
    expect(entries.some((name) => name.startsWith(`.${manifest.artifact.sha256}.bin.`) && name.endsWith('.part'))).toBe(true);
    await expect(new LocalFirmwareBuildStore(owned).importManifest(manifestPath)).rejects.toThrow(/exactly one filesystem link/i);
  });
});

function firmwareBytes(): Uint8Array {
  const bytes = new Uint8Array(8_192);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x2000_a000, true);
  view.setUint32(4, 0x0800_0009, true);
  bytes.set(new TextEncoder().encode('tinySA4_lab-v0.2.0-g1234567'), 100);
  bytes.set(new TextEncoder().encode('+ ZS407'), 200);
  return bytes;
}

function manifestFor(bytes: Uint8Array): LocalFirmwareBuildManifest {
  return localFirmwareBuildManifestSchema.parse({
    $schema: 'https://physicistjohn.github.io/tinysa-flasher/contracts/schemas/tinysa-firmware-build-manifest-v1.schema.json',
    manifestVersion: 1,
    artifact: {
      filename: 'tinySA4_lab-v0.2.0-g1234567.bin',
      format: 'raw-stm32-binary',
      sizeBytes: bytes.byteLength,
      sha256: digest(bytes),
      loadAddress: '0x08000000',
      maximumWriteBytes: 245_760,
      initialStackPointer: '0x2000a000',
      resetHandler: '0x08000009',
    },
    firmware: {
      product: 'tinySA Ultra / Ultra+',
      hardwareTarget: 'ZS407',
      mcu: 'STM32F303',
      version: 'tinySA4_lab-v0.2.0-g1234567',
      reportedRevision: '1234567',
      sourceRepository: 'PhysicistJohn/TinySA_Firmware',
      sourceCommit: `1234567${'a'.repeat(33)}`,
      sourceTree: 'tracked-clean',
      chibiosCommit: 'b'.repeat(40),
    },
    build: {
      sourceDateEpoch: 1_750_000_000,
      toolchain: 'arm-none-eabi-gcc 11.3.1',
      reproducibleCleanBuilds: true,
      hardwareQualification: 'unqualified',
      simulationQualification: 'passed',
    },
    flashPolicy: {
      physicalFlash: 'operator-confirmed-only',
      automatedFlash: false,
      requiresKnownGoodRollback: true,
    },
  });
}

async function writeBuild(directory: string, bytes: Uint8Array, manifest: LocalFirmwareBuildManifest): Promise<string> {
  await writeFile(join(directory, manifest.artifact.filename), bytes, { mode: 0o600 });
  const manifestPath = join(directory, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return manifestPath;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tinysa-local-build-'));
  directories.push(directory);
  return directory;
}

function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
