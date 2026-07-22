import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LEGACY_MANIFEST_SCHEMA_ID,
  MANIFEST_SCHEMA_ID,
  localFirmwareBuildManifestSchema,
} from '../src/core/local-firmware-build.js';

function manifest(version: 1 | 2) {
  return {
    $schema: version === 1 ? LEGACY_MANIFEST_SCHEMA_ID : MANIFEST_SCHEMA_ID,
    manifestVersion: version,
    artifact: {
      filename: 'tinySA4_test-g1111111.bin',
      format: 'raw-stm32-binary',
      sizeBytes: 8192,
      sha256: 'a'.repeat(64),
      loadAddress: '0x08000000',
      maximumWriteBytes: 245760,
      initialStackPointer: '0x2000a000',
      resetHandler: '0x08000009',
    },
    firmware: {
      product: 'tinySA Ultra / Ultra+',
      hardwareTarget: 'ZS407',
      mcu: 'STM32F303',
      version: 'tinySA4_test-g1111111',
      reportedRevision: '1111111',
      sourceRepository: version === 1 ? 'PhysicistJohn/TinySA_Firmware' : 'PhysicistJohn/Atom-Firmware',
      sourceCommit: '1'.repeat(40),
      sourceTree: 'tracked-clean',
      chibiosCommit: '2'.repeat(40),
    },
    build: {
      sourceDateEpoch: 1_700_000_000,
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
  };
}

describe('local firmware manifest versions', () => {
  it('publishes a v2 JSON Schema with the same canonical identity', () => {
    const schema = JSON.parse(readFileSync(
      new URL('../contracts/schemas/tinysa-firmware-build-manifest-v2.schema.json', import.meta.url),
      'utf8',
    ));
    expect(schema.$id).toBe(MANIFEST_SCHEMA_ID);
    expect(schema.properties.$schema.const).toBe(MANIFEST_SCHEMA_ID);
    expect(schema.properties.firmware.properties.sourceRepository.const).toBe('PhysicistJohn/Atom-Firmware');
  });

  it('retains exact v1 admission for historical packages', () => {
    expect(localFirmwareBuildManifestSchema.safeParse(manifest(1)).success).toBe(true);
  });

  it('admits v2 packages owned by Atom-Firmware', () => {
    expect(localFirmwareBuildManifestSchema.safeParse(manifest(2)).success).toBe(true);
  });

  it('rejects cross-version schema and repository identity mixing', () => {
    expect(localFirmwareBuildManifestSchema.safeParse({
      ...manifest(2),
      $schema: LEGACY_MANIFEST_SCHEMA_ID,
    }).success).toBe(false);
    expect(localFirmwareBuildManifestSchema.safeParse({
      ...manifest(2),
      firmware: { ...manifest(2).firmware, sourceRepository: 'PhysicistJohn/TinySA_Firmware' },
    }).success).toBe(false);
  });
});
