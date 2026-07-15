import { describe, expect, it, vi } from 'vitest';
import type { LocalCustomFirmwareTarget } from '../src/core/contracts.js';
import type { LocalFirmwareBuildStore, ImportedLocalFirmwareBuild } from '../src/core/local-firmware-build.js';
import { LocalFirmwareTargetPicker } from '../src/main/local-firmware-target-picker.js';

const target = {
  kind: 'local-custom',
  targetId: `custom-zs407-${'a'.repeat(64)}`,
  product: 'tinySA Ultra / Ultra+',
  version: 'tinySA4_custom-gaaaaaaa',
  revision: 'aaaaaaa',
  sourceCommit: 'a'.repeat(40),
  sha256: 'a'.repeat(64),
  sizeBytes: 8_192,
  manifestSha256: 'b'.repeat(64),
  hardwareQualification: 'unqualified',
  buildProvenance: {
    sourceRepository: 'PhysicistJohn/TinySA_Firmware',
    chibiosCommit: 'c'.repeat(40),
    sourceDateEpoch: 1,
    toolchain: 'arm-none-eabi-gcc 12',
    reproducibleCleanBuilds: true,
    simulationQualification: 'not-run',
  },
  transportIntegrity: 'local-manifest-sha256',
} as const satisfies LocalCustomFirmwareTarget;

describe('LocalFirmwareTargetPicker', () => {
  it('treats a cancelled native picker as a side-effect-free cancellation', async () => {
    const store = { importManifest: vi.fn() } as unknown as LocalFirmwareBuildStore;
    const picker = new LocalFirmwareTargetPicker(
      () => undefined,
      { chooseManifest: vi.fn().mockResolvedValue(undefined) },
      store,
    );
    await expect(picker.selectLocalFirmwareTarget()).resolves.toBeUndefined();
    expect(store.importManifest).not.toHaveBeenCalled();
  });

  it('does not expose a native selected path through an admission failure', async () => {
    const privatePath = '/Users/operator/private/build/manifest.json';
    const store = {
      importManifest: vi.fn().mockRejectedValue(new Error(`ENOENT: ${privatePath}`)),
    } as unknown as LocalFirmwareBuildStore;
    const picker = new LocalFirmwareTargetPicker(
      () => undefined,
      { chooseManifest: vi.fn().mockResolvedValue(privatePath) },
      store,
    );

    const failure = await picker.selectLocalFirmwareTarget().then(() => undefined, (value: unknown) => value);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/could not be admitted/i);
    expect((failure as Error).message).not.toContain(privatePath);
  });

  it('returns only a target and an opaque re-verifying artifact capability', async () => {
    const imported = {
      manifest: {},
      manifestSha256: target.manifestSha256,
      artifactPath: '/owned/custom.bin',
      manifestPath: '/owned/custom.manifest.json',
      importedAt: '2026-07-14T12:00:00.000Z',
    } as unknown as ImportedLocalFirmwareBuild;
    const bytes = new Uint8Array(target.sizeBytes);
    const importManifest = vi.fn().mockResolvedValue(imported);
    const verified = {
      descriptor: 41,
      bytes,
      assertStable: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const openVerified = vi.fn().mockResolvedValue(verified);
    const store = { importManifest, openVerified } as unknown as LocalFirmwareBuildStore;
    const picker = new LocalFirmwareTargetPicker(
      () => undefined,
      { chooseManifest: vi.fn().mockResolvedValue('/operator/build.json') },
      store,
    );

    // Keep this unit focused on native-path confinement and capability shape;
    // manifest-to-target validation is exhaustively covered by the store tests.
    const module = await import('../src/core/local-firmware-build.js');
    const mapper = vi.spyOn(module, 'localCustomTargetForBuild').mockReturnValue(target);
    try {
      const selected = await picker.selectLocalFirmwareTarget();
      expect(importManifest).toHaveBeenCalledWith('/operator/build.json');
      expect(selected).toEqual({
        target,
        artifact: expect.objectContaining({ targetId: target.targetId, openVerified: expect.any(Function) }),
      });
      await expect(selected!.artifact.openVerified()).resolves.toBe(verified);
      expect(openVerified).toHaveBeenCalledWith(imported);
      expect(selected!.artifact).not.toHaveProperty('path');
      expect(selected).not.toHaveProperty('selectedPath');

      openVerified.mockRejectedValueOnce(new Error('EIO: /app-owned/private/custom.bin'));
      const failure = await selected!.artifact.openVerified().then(() => undefined, (value: unknown) => value);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe('The app-owned local firmware build could not be reopened and verified');
      expect((failure as Error).message).not.toContain('/app-owned/private');
    } finally {
      mapper.mockRestore();
    }
  });
});
