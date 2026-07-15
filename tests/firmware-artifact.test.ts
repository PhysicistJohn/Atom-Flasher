import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FirmwareArtifactStore,
  readResponseBodyBounded,
  type FirmwareArtifactRuntime,
} from '../src/core/firmware-artifact.js';
import { OEM_ZS407_FIRMWARE_RELEASE } from '../src/core/contracts.js';

const roots: string[] = [];
const fixtureByte = 0xa5;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('bounded firmware response body', () => {
  it('accepts exactly the declared bytes and rejects either side of the bound', async () => {
    await expect(readResponseBodyBounded(response(Uint8Array.of(1, 2, 3)), 3)).resolves.toEqual(Uint8Array.of(1, 2, 3));
    await expect(readResponseBodyBounded(response(Uint8Array.of(1, 2)), 3)).rejects.toThrow(/has 2 bytes, expected exactly 3/i);
    await expect(readResponseBodyBounded(response(Uint8Array.of(1, 2, 3, 4)), 3)).rejects.toThrow(/exceeds pinned 3-byte bound/i);
  });

  it('rejects unsafe allocation bounds before reading a body', async () => {
    await expect(readResponseBodyBounded(response(Uint8Array.of()), -1)).rejects.toThrow(RangeError);
    await expect(readResponseBodyBounded(response(Uint8Array.of()), 1.5)).rejects.toThrow(RangeError);
    await expect(readResponseBodyBounded(response(Uint8Array.of()), OEM_ZS407_FIRMWARE_RELEASE.sizeBytes + 1)).rejects.toThrow(RangeError);
  });
});

describe('create-once firmware artifact store', () => {
  it('durably stages and atomically creates the canonical image with restrictive permissions', async () => {
    const directory = await temporaryDirectory();
    const bytes = fixtureFirmware();
    const fetch = vi.fn(async () => response(bytes, true));
    const store = new FirmwareArtifactStore(directory, runtime(fetch));

    await expect(store.download()).resolves.toMatchObject({
      sizeBytes: OEM_ZS407_FIRMWARE_RELEASE.sizeBytes,
      sha256: OEM_ZS407_FIRMWARE_RELEASE.sha256,
    });

    const metadata = await stat(store.path);
    expect(metadata.isFile()).toBe(true);
    expect(metadata.size).toBe(bytes.byteLength);
    expect(metadata.mode & 0o777).toBe(0o600);
    expect((await readdir(directory)).filter((name) => name.endsWith('.part'))).toEqual([]);
    await expect(store.readVerified()).resolves.toEqual(bytes);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retains the fsynced staging link when canonical-name durability is uncertain', async () => {
    const directory = await temporaryDirectory();
    const store = new FirmwareArtifactStore(directory, runtime(vi.fn(async () => response(fixtureFirmware(), true))));
    const durableFiles = await import('../src/core/persistence/durable-files.js');
    const sync = vi.spyOn(durableFiles, 'syncDirectory').mockRejectedValueOnce(new Error('forced directory sync failure'));
    try {
      await expect(store.download()).rejects.toThrow(/forced directory sync failure/i);
    } finally {
      sync.mockRestore();
    }

    const entries = await readdir(directory);
    expect(entries).toContain(`${OEM_ZS407_FIRMWARE_RELEASE.version}.bin`);
    expect(entries.some((name) => name.endsWith('.part'))).toBe(true);
    expect((await stat(store.path)).nlink).toBe(2);
    await expect(store.openVerified()).rejects.toThrow(/exactly one filesystem link/i);
  });

  it('verifies and reuses an existing canonical image without fetching or replacing it', async () => {
    const directory = await temporaryDirectory();
    const bytes = fixtureFirmware();
    const store = new FirmwareArtifactStore(
      directory,
      runtime(vi.fn(async () => { throw new Error('network must not be used'); })),
    );
    await writeFile(store.path, bytes, { flag: 'wx', mode: 0o600 });
    const before = await stat(store.path);

    await expect(store.download()).resolves.toMatchObject({ sha256: OEM_ZS407_FIRMWARE_RELEASE.sha256 });
    const after = await stat(store.path);
    expect(after.ino).toBe(before.ino);
    await expect(store.readVerified()).resolves.toEqual(bytes);
  });

  it('retains the exact verified descriptor at offset zero until explicitly closed', async () => {
    const directory = await temporaryDirectory();
    const bytes = fixtureFirmware();
    bytes.set([0xa5, 0x12, 0x34, 0x56], 0);
    const store = new FirmwareArtifactStore(directory, runtime(vi.fn(async () => {
      throw new Error('network must not be used');
    })));
    await writeFile(store.path, bytes, { flag: 'wx', mode: 0o600 });

    const verified = await store.openVerified();
    try {
      const first = Buffer.alloc(4);
      expect(readSync(verified.descriptor, first, 0, first.byteLength, null)).toBe(4);
      expect([...first]).toEqual([0xa5, 0x12, 0x34, 0x56]);
    } finally {
      await verified.close();
    }
    await expect(verified.assertStable()).rejects.toThrow(/already closed/i);
  });

  it('rejects in-place mutation that occurs while the open descriptor is being verified', async () => {
    const directory = await temporaryDirectory();
    const bytes = fixtureFirmware();
    const canonicalPath = join(directory, `${OEM_ZS407_FIRMWARE_RELEASE.version}.bin`);
    await writeFile(canonicalPath, bytes, { flag: 'wx', mode: 0o600 });
    const store = new FirmwareArtifactStore(directory, {
      ...runtime(vi.fn(async () => { throw new Error('network must not be used'); })),
      verify: (observed) => {
        verifyFixture(observed);
        const mutated = observed.slice();
        mutated[100] = mutated[100]! ^ 1;
        writeFileSync(canonicalPath, mutated);
      },
    });

    await expect(store.openVerified()).rejects.toThrow(/changed while it was being verified/i);
  });

  it('retains a valid canonical artifact that wins a concurrent create collision', async () => {
    const directory = await temporaryDirectory();
    const bytes = fixtureFirmware();
    let collisionInode: bigint | number | undefined;
    const canonicalPath = join(directory, `${OEM_ZS407_FIRMWARE_RELEASE.version}.bin`);
    const runtime: FirmwareArtifactRuntime = {
      fetch: vi.fn(async () => {
        await writeFile(canonicalPath, bytes, { flag: 'wx', mode: 0o600 });
        collisionInode = (await stat(canonicalPath)).ino;
        return response(bytes, true);
      }),
      verify: verifyFixture,
      now: () => new Date('2026-07-14T00:00:00.000Z'),
      randomUuid: () => randomUUID(),
    };
    const store = new FirmwareArtifactStore(directory, runtime);

    await expect(store.download()).resolves.toMatchObject({ sha256: OEM_ZS407_FIRMWARE_RELEASE.sha256 });
    expect((await stat(store.path)).ino).toBe(collisionInode);
    expect((await readdir(directory)).filter((name) => name.endsWith('.part'))).toEqual([]);
  });

  it('never overwrites an invalid canonical artifact, including a concurrent collision', async () => {
    const directory = await temporaryDirectory();
    const bytes = fixtureFirmware();
    const collision = new Uint8Array(OEM_ZS407_FIRMWARE_RELEASE.sizeBytes).fill(0x5a);
    const canonicalPath = join(directory, `${OEM_ZS407_FIRMWARE_RELEASE.version}.bin`);
    const runtime: FirmwareArtifactRuntime = {
      fetch: vi.fn(async () => {
        await writeFile(canonicalPath, collision, { flag: 'wx', mode: 0o600 });
        return response(bytes, true);
      }),
      verify: verifyFixture,
      now: () => new Date('2026-07-14T00:00:00.000Z'),
      randomUuid: () => randomUUID(),
    };
    const store = new FirmwareArtifactStore(directory, runtime);

    await expect(store.download()).rejects.toThrow(/collision was retained and rejected/i);
    expect(new Uint8Array(await readFile(store.path))).toEqual(collision);
    expect((await readdir(directory)).filter((name) => name.endsWith('.part'))).toEqual([]);
  });

  it('does not fetch or replace an invalid canonical artifact found before download', async () => {
    const directory = await temporaryDirectory();
    const invalid = new Uint8Array(OEM_ZS407_FIRMWARE_RELEASE.sizeBytes).fill(0x5a);
    const fetch = vi.fn(async () => response(fixtureFirmware(), true));
    const store = new FirmwareArtifactStore(directory, runtime(fetch));
    await writeFile(store.path, invalid, { flag: 'wx', mode: 0o600 });
    const before = await stat(store.path);

    await expect(store.download()).rejects.toThrow(/fixture firmware verification failed/i);
    expect(fetch).not.toHaveBeenCalled();
    expect((await stat(store.path)).ino).toBe(before.ino);
    expect(new Uint8Array(await readFile(store.path))).toEqual(invalid);
  });

  it('never removes a pre-existing staging-name collision it did not create', async () => {
    const directory = await temporaryDirectory();
    const uuid = '018f61e4-9020-7d42-909d-68b60f08e900';
    const store = new FirmwareArtifactStore(directory, runtime(
      vi.fn(async () => response(fixtureFirmware(), true)),
      uuid,
    ));
    const stagingPath = join(directory, `.${OEM_ZS407_FIRMWARE_RELEASE.version}.bin.${uuid}.part`);
    const unowned = Uint8Array.of(9, 8, 7);
    await writeFile(stagingPath, unowned, { flag: 'wx', mode: 0o600 });

    await expect(store.download()).rejects.toMatchObject({ code: 'EEXIST' });
    expect(new Uint8Array(await readFile(stagingPath))).toEqual(unowned);
    await expect(stat(store.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a symbolic-link canonical path instead of following or replacing it', async () => {
    const directory = await temporaryDirectory();
    const outside = join(directory, 'outside.bin');
    const store = new FirmwareArtifactStore(
      directory,
      runtime(vi.fn(async () => response(fixtureFirmware(), true))),
    );
    await writeFile(outside, fixtureFirmware());
    await symlink(outside, store.path);

    await expect(store.download()).rejects.toThrow();
    expect((await stat(outside)).size).toBe(OEM_ZS407_FIRMWARE_RELEASE.sizeBytes);
  });
});

function fixtureFirmware(): Uint8Array {
  return new Uint8Array(OEM_ZS407_FIRMWARE_RELEASE.sizeBytes).fill(fixtureByte);
}

function verifyFixture(bytes: Uint8Array): void {
  if (bytes.byteLength !== OEM_ZS407_FIRMWARE_RELEASE.sizeBytes || bytes[0] !== fixtureByte) {
    throw new Error('fixture firmware verification failed');
  }
}

function runtime(fetch: FirmwareArtifactRuntime['fetch'], uuid = randomUUID()): FirmwareArtifactRuntime {
  return {
    fetch,
    verify: verifyFixture,
    now: () => new Date('2026-07-14T00:00:00.000Z'),
    randomUuid: () => uuid,
  };
}

function response(bytes: Uint8Array, includeLength = false): Response {
  return new Response(Uint8Array.from(bytes).buffer, {
    status: 200,
    ...(includeLength ? { headers: { 'content-length': String(bytes.byteLength) } } : {}),
  });
}

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tinysa-artifact-test-'));
  roots.push(root);
  return root;
}
