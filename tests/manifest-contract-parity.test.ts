import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import manifestSchema from '../contracts/schemas/tinysa-firmware-build-manifest-v1.schema.json';
import {
  MANIFEST_SCHEMA_ID,
  localFirmwareBuildManifestSchema,
} from '../src/core/local-firmware-build.js';

const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
const validateManifest = ajv.compile(manifestSchema);

function validManifest() {
  return {
    $schema: MANIFEST_SCHEMA_ID,
    manifestVersion: 1,
    artifact: {
      filename: 'tinySA4_dev-225-g1111111.bin',
      format: 'raw-stm32-binary',
      sizeBytes: 180_000,
      sha256: 'a'.repeat(64),
      loadAddress: '0x08000000',
      maximumWriteBytes: 245_760,
      initialStackPointer: '0x20001000',
      resetHandler: '0x08000101',
    },
    firmware: {
      product: 'tinySA Ultra / Ultra+',
      hardwareTarget: 'ZS407',
      mcu: 'STM32F303',
      version: 'tinySA4_dev-225-g1111111',
      reportedRevision: '1111111',
      sourceRepository: 'PhysicistJohn/TinySA_Firmware',
      sourceCommit: '1'.repeat(40),
      sourceTree: 'tracked-clean',
      chibiosCommit: '2'.repeat(40),
    },
    build: {
      sourceDateEpoch: 1_700_000_000,
      toolchain: 'arm-none-eabi-gcc 13.2.1',
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

describe('local firmware manifest JSON/runtime contract parity', () => {
  it('pins one canonical schema identity and accepts valid qualified and unqualified manifests', () => {
    expect(manifestSchema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(manifestSchema.$id).toBe(MANIFEST_SCHEMA_ID);
    const unqualified = validManifest();
    const qualified = {
      ...validManifest(),
      build: {
        ...validManifest().build,
        hardwareQualification: 'qualified-on-zs407',
        qualificationEvidenceSha256: 'b'.repeat(64),
      },
    };
    for (const value of [unqualified, qualified]) {
      expect(validateManifest(value), JSON.stringify(validateManifest.errors)).toBe(true);
      expect(localFirmwareBuildManifestSchema.safeParse(value).success).toBe(true);
    }
  });

  it('rejects the same structural bounds and missing qualified-build evidence', () => {
    const base = validManifest();
    const invalidValues = [
      { ...base, artifact: { ...base.artifact, sizeBytes: 245_761 } },
      { ...base, artifact: { ...base.artifact, filename: `${'a'.repeat(157)}.bin` } },
      { ...base, build: { ...base.build, hardwareQualification: 'qualified-on-zs407' } },
    ];
    for (const value of invalidValues) {
      expect(validateManifest(value)).toBe(false);
      expect(localFirmwareBuildManifestSchema.safeParse(value).success).toBe(false);
    }
  });

  it('rejects qualification evidence on unqualified builds in both contracts', () => {
    const unqualifiedWithEvidence = {
      ...validManifest(),
      build: {
        ...validManifest().build,
        qualificationEvidenceSha256: 'b'.repeat(64),
      },
    };
    expect(validateManifest(unqualifiedWithEvidence)).toBe(false);
    expect(localFirmwareBuildManifestSchema.safeParse(unqualifiedWithEvidence).success).toBe(false);
  });

  it('keeps provenance relationships as explicit runtime semantic refinements', () => {
    const revisionMismatch = {
      ...validManifest(),
      firmware: { ...validManifest().firmware, reportedRevision: '2222222' },
    };
    const commitMismatch = {
      ...validManifest(),
      firmware: { ...validManifest().firmware, sourceCommit: '2'.repeat(40) },
    };
    for (const value of [revisionMismatch, commitMismatch]) {
      expect(validateManifest(value), JSON.stringify(validateManifest.errors)).toBe(true);
      expect(localFirmwareBuildManifestSchema.safeParse(value).success).toBe(false);
    }
  });
});
