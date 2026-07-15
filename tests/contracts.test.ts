import { describe, expect, it } from 'vitest';
import activeReleaseManifest from '../contracts/releases/oem-zs407-c979386-v1.json';
import {
  OEM_ZS407_FIRMWARE_RELEASE,
  OEM_ZS407_FIRMWARE_TARGET,
  OEM_ZS407_SELF_TEST_PROCEDURE,
  SCREEN_BYTES,
  ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT,
  ZS407_SHIPPED_FIRMWARE_VERSION,
  deviceDiagnosticsSchema,
  deviceIdentitySchema,
  deviceSnapshotSchema,
  deviceTelemetrySchema,
  dfuDeviceStateSchema,
  dfuUtilityStateSchema,
  firmwareFlashRequestSchema,
  firmwarePreparationSchema,
  firmwareUpdatePreflightSchema,
  firmwareUpdateStateSchema,
  initialFirmwareUpdateState,
  localCustomFirmwareTargetSchema,
  portCandidateSchema,
  screenFrameSchema,
} from '../src/core/contracts.js';

const preparationId = 'a5ada7f3-fbe3-41bd-83ac-a07028bc55f6';
const verifiedAt = '2026-07-14T12:00:00.000Z';
const preparedAt = '2026-07-14T12:01:00.000Z';
const writeStartedAt = '2026-07-14T12:02:00.000Z';
const writeCompletedAt = '2026-07-14T12:03:00.000Z';
const completedAt = '2026-07-14T12:04:00.000Z';
const exactPort = {
  id: '/dev/tty.CDC407:CDC407:0483:5740',
  path: '/dev/tty.CDC407',
  vendorId: '0483',
  productId: '5740',
  serialNumber: 'CDC407',
  usbMatch: 'exact-zs407-cdc',
} as const;
const telemetry = { batteryMillivolts: 4_211, deviceId: 407, capturedAt: preparedAt } as const;
const shippedIdentity = {
  model: 'tinySA Ultra+ ZS407',
  hardwareVersion: 'V0.5.4 + ZS407',
  firmwareVersion: ZS407_SHIPPED_FIRMWARE_VERSION,
  firmwareReportedRevision: 'c5dd31f',
  firmwareSourceCommit: ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT,
  firmwareQualification: 'supported-oem',
  port: exactPort,
  usbIdentityVerified: true,
} as const;
const shippedCurrent = {
  version: ZS407_SHIPPED_FIRMWARE_VERSION,
  revision: 'c5dd31f',
  sourceCommit: ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT,
  qualification: 'supported-oem',
} as const;
const targetCurrent = {
  version: OEM_ZS407_FIRMWARE_RELEASE.version,
  revision: OEM_ZS407_FIRMWARE_RELEASE.revision,
  sourceCommit: OEM_ZS407_FIRMWARE_RELEASE.sourceCommit,
  qualification: 'supported-oem',
} as const;
const artifact = {
  targetId: OEM_ZS407_FIRMWARE_TARGET.targetId,
  sizeBytes: OEM_ZS407_FIRMWARE_RELEASE.sizeBytes,
  sha256: OEM_ZS407_FIRMWARE_RELEASE.sha256,
  verifiedAt,
} as const;
const preparation = {
  id: preparationId,
  preparedAt,
  batteryMillivolts: telemetry.batteryMillivolts,
  deviceId: telemetry.deviceId,
  screenSha256: 'a'.repeat(64),
  selfTestPassed: true,
  selfTestProcedure: OEM_ZS407_SELF_TEST_PROCEDURE.id,
  configurationDisposition: 'new-device-unchanged',
  rfPortsDisconnected: true,
  onlyUsbDeviceConnected: true,
  usbContinuity: {
    cdcPath: exactPort.path,
    cdcSerialNumber: exactPort.serialNumber,
    vendorId: '0483',
    productId: '5740',
    deviceId: telemetry.deviceId,
  },
} as const;
const dfuIdentity = {
  path: '1-1',
  devnum: '5',
  serial: 'DFU407',
  alt: 0,
  name: '@Internal Flash  /0x08000000/128*002Kg',
  fingerprint: '{"path":"1-1","devnum":"5","serial":"DFU407","alt":0,"name":"@Internal Flash  /0x08000000/128*002Kg"}',
  targetLine: 'Found DFU: [0483:df11] devnum=5, path="1-1", alt=0, name="@Internal Flash  /0x08000000/128*002Kg", serial="DFU407"',
} as const;

function verifiedState() {
  return {
    ...initialFirmwareUpdateState(),
    phase: 'verified' as const,
    targetRelation: 'different-supported' as const,
    writeIntent: 'update-oem' as const,
    updateAvailable: true,
    current: shippedCurrent,
    artifact,
  };
}

function awaitingDfuState() {
  return {
    ...verifiedState(),
    phase: 'awaiting-dfu' as const,
    preparation,
  };
}

function readyToFlashState() {
  return {
    ...awaitingDfuState(),
    phase: 'ready-to-flash' as const,
    dfuUtility: { available: true, version: '0.11' },
    dfuDevice: { detected: true, count: 1, identity: dfuIdentity },
  };
}

describe('standalone flasher contracts', () => {
  it('admits exact ZS407 USB identity and rejects a mislabeled candidate', () => {
    expect(portCandidateSchema.parse({ id: 'one', path: '/dev/tty.usb', vendorId: '0483', productId: '5740', usbMatch: 'exact-zs407-cdc' }).usbMatch).toBe('exact-zs407-cdc');
    expect(() => portCandidateSchema.parse({ id: 'bad', path: '/dev/tty.bad', vendorId: '1234', productId: '5740', usbMatch: 'exact-zs407-cdc' })).toThrow(/0483:5740/);
  });

  it('requires every human preflight attestation', () => {
    const valid = {
      selfTestPassed: true,
      selfTestProcedure: 'tinySA4-zs407-cal-rf-v1',
      configurationDisposition: 'new-device-unchanged',
      rfPortsDisconnected: true,
      onlyUsbDeviceConnected: true,
    };
    expect(firmwareUpdatePreflightSchema.safeParse(valid).success).toBe(true);
    expect(firmwareUpdatePreflightSchema.safeParse({ ...valid, onlyUsbDeviceConnected: false }).success).toBe(false);
    expect(firmwareUpdatePreflightSchema.safeParse({ ...valid, rfPortsDisconnected: false }).success).toBe(false);
  });

  it('keeps the flash confirmation literal out of renderer discretion', () => {
    expect(firmwareFlashRequestSchema.safeParse({ preparationId, confirmation: 'FLASH VERIFIED OEM FIRMWARE' }).success).toBe(true);
    expect(firmwareFlashRequestSchema.safeParse({ preparationId, confirmation: 'FLASH VERIFIED CUSTOM FIRMWARE' }).success).toBe(true);
    expect(firmwareFlashRequestSchema.safeParse({ preparationId, confirmation: 'yes' }).success).toBe(false);
  });

  it('validates device identities, diagnostics, snapshots, and exact screen frames at runtime', () => {
    expect(deviceIdentitySchema.safeParse(shippedIdentity).success).toBe(true);
    expect(deviceTelemetrySchema.safeParse(telemetry).success).toBe(true);
    expect(deviceDiagnosticsSchema.safeParse({
      identity: shippedIdentity,
      firmwareVersionResponse: `${ZS407_SHIPPED_FIRMWARE_VERSION}\r\nHW Version: V0.5.4 + ZS407`,
      infoLines: ['tinySA ULTRA+ ZS407'],
      commands: ['version', 'capture'],
      telemetry,
      capturedAt: preparedAt,
    }).success).toBe(true);
    expect(deviceSnapshotSchema.safeParse({
      connection: 'ready', identity: shippedIdentity, telemetry, connectedAt: preparedAt,
    }).success).toBe(true);
    expect(screenFrameSchema.safeParse({
      width: 480, height: 320, format: 'rgb565le', pixels: new Uint8Array(SCREEN_BYTES), capturedAt: preparedAt,
    }).success).toBe(true);

    expect(deviceIdentitySchema.safeParse({
      ...shippedIdentity,
      firmwareQualification: 'custom-unqualified',
      firmwareWarning: 'Unqualified build',
    }).success).toBe(false);
    expect(deviceSnapshotSchema.safeParse({ connection: 'ready' }).success).toBe(false);
    expect(deviceSnapshotSchema.safeParse({ connection: 'faulted' }).success).toBe(false);
    expect(screenFrameSchema.safeParse({
      width: 480, height: 320, format: 'rgb565le', pixels: new Uint8Array(SCREEN_BYTES - 2), capturedAt: preparedAt,
    }).success).toBe(false);
  });

  it('couples DFU availability and detection claims to their required evidence', () => {
    expect(dfuUtilityStateSchema.safeParse({ available: true, version: '0.11' }).success).toBe(true);
    expect(dfuUtilityStateSchema.safeParse({ available: false }).success).toBe(true);
    expect(dfuUtilityStateSchema.safeParse({ available: true }).success).toBe(false);
    expect(dfuUtilityStateSchema.safeParse({ available: true, version: '0.10' }).success).toBe(false);
    expect(dfuUtilityStateSchema.safeParse({ available: false, version: '0.11' }).success).toBe(false);

    expect(dfuDeviceStateSchema.safeParse({ detected: true, count: 1, identity: dfuIdentity }).success).toBe(true);
    expect(dfuDeviceStateSchema.safeParse({ detected: false, count: 0 }).success).toBe(true);
    expect(dfuDeviceStateSchema.safeParse({ detected: true, count: 1 }).success).toBe(false);
    expect(dfuDeviceStateSchema.safeParse({ detected: false, count: 0, identity: dfuIdentity }).success).toBe(false);
    expect(dfuDeviceStateSchema.safeParse({
      detected: true, count: 1, identity: { ...dfuIdentity, fingerprint: 'opaque-and-unverifiable' },
    }).success).toBe(false);
    expect(dfuDeviceStateSchema.safeParse({
      detected: true, count: 1, identity: { ...dfuIdentity, targetLine: dfuIdentity.targetLine.replace('devnum=5', 'devnum=6') },
    }).success).toBe(false);
  });

  it('requires one device ID across preparation and USB continuity evidence', () => {
    expect(firmwarePreparationSchema.safeParse(preparation).success).toBe(true);
    expect(firmwarePreparationSchema.safeParse({
      ...preparation,
      usbContinuity: { ...preparation.usbContinuity, deviceId: preparation.deviceId + 1 },
    }).success).toBe(false);
  });

  it('admits the updater\'s verified, prepared, ready, and completed transition shapes', () => {
    expect(firmwareUpdateStateSchema.safeParse(verifiedState()).success).toBe(true);
    expect(firmwareUpdateStateSchema.safeParse(awaitingDfuState()).success).toBe(true);
    expect(firmwareUpdateStateSchema.safeParse(readyToFlashState()).success).toBe(true);
    const completed = {
      ...readyToFlashState(),
      phase: 'completed' as const,
      targetRelation: 'same' as const,
      updateAvailable: false,
      current: targetCurrent,
      writeDisposition: 'completed' as const,
      writeStartedAt,
      writeCompletedAt,
      completedAt,
      flashProgress: { stage: 'complete' as const, percent: 100, stagePercent: 100, updatedAt: completedAt },
    };
    expect(firmwareUpdateStateSchema.safeParse(completed).success).toBe(true);
    expect(firmwareUpdateStateSchema.safeParse({ ...completed, phase: 'failed', error: 'completion archival failed' }).success).toBe(true);
    expect(firmwareUpdateStateSchema.safeParse({
      ...completed,
      phase: 'failed',
      error: 'claimed verification before completion',
      flashProgress: { stage: 'verifying-reboot', percent: 98, stagePercent: 100, updatedAt: completedAt },
    }).success).toBe(false);
    expect(firmwareUpdateStateSchema.safeParse({ ...completed, phase: 'failed', writeIntent: 'restore-oem', error: 'completion archival failed' }).success).toBe(true);
    expect(firmwareUpdateStateSchema.safeParse({ ...completed, phase: 'failed', writeIntent: 'install-custom', error: 'wrong intent' }).success).toBe(false);
  });

  it('rejects phase labels without the safety evidence they claim', () => {
    expect(firmwareUpdateStateSchema.safeParse({
      ...initialFirmwareUpdateState(), phase: 'verified', updateAvailable: true, current: shippedCurrent,
    }).success).toBe(false);
    expect(firmwareUpdateStateSchema.safeParse({
      ...verifiedState(), phase: 'awaiting-dfu',
    }).success).toBe(false);
    expect(firmwareUpdateStateSchema.safeParse({
      ...awaitingDfuState(), phase: 'ready-to-flash',
    }).success).toBe(false);
    expect(firmwareUpdateStateSchema.safeParse({
      ...initialFirmwareUpdateState(),
      phase: 'completed',
      writeDisposition: 'completed',
      writeStartedAt,
      writeCompletedAt,
      completedAt,
    }).success).toBe(false);
  });

  it('rejects ready-to-flash state without one persisted DFU identity', () => {
    const state = { ...initialFirmwareUpdateState(), phase: 'ready-to-flash', updateAvailable: true, dfuDevice: { detected: true, count: 1 } };
    expect(firmwareUpdateStateSchema.safeParse(state).success).toBe(false);
  });

  it.each([
    'tinySA4_custom-gc979386',
    'tinySA4_v1.4-224-gc979386-dirty',
  ])('cannot persist spoofed version %s as supported OEM provenance', (version) => {
    const state = {
      ...initialFirmwareUpdateState(),
      current: {
        version,
        revision: OEM_ZS407_FIRMWARE_RELEASE.revision,
        sourceCommit: OEM_ZS407_FIRMWARE_RELEASE.sourceCommit,
        qualification: 'supported-oem',
      },
    };
    expect(firmwareUpdateStateSchema.safeParse(state).success).toBe(false);
  });

  it('pins the immutable release metadata', () => {
    const releaseFields = ['product', 'version', 'revision', 'sourceCommit', 'publishedAt', 'downloadUrl', 'sha256', 'sizeBytes', 'transportIntegrity'] as const;
    const canonicalRelease = Object.fromEntries(releaseFields.map((field) => [field, activeReleaseManifest[field]]));
    expect(OEM_ZS407_FIRMWARE_RELEASE).toEqual(canonicalRelease);
    expect(OEM_ZS407_FIRMWARE_RELEASE).toMatchObject({
      revision: 'c979386',
      sizeBytes: 185_704,
      sha256: '3c9847ff4d7b80561df2f2f1030a112703a083409ffb2ee11361b2413b7c1e41',
    });
  });

  it('admits content-addressed custom targets without letting them claim OEM identities', () => {
    const sha256 = 'd'.repeat(64);
    const target = {
      kind: 'local-custom',
      targetId: `custom-zs407-${sha256}`,
      product: OEM_ZS407_FIRMWARE_RELEASE.product,
      version: 'tinySA4_dev-225-g1111111',
      revision: '1111111',
      sourceCommit: '1'.repeat(40),
      sha256,
      sizeBytes: 180_000,
      manifestSha256: 'e'.repeat(64),
      hardwareQualification: 'qualified',
      qualificationEvidenceSha256: 'f'.repeat(64),
      buildProvenance: {
        sourceRepository: 'PhysicistJohn/TinySA_Firmware',
        chibiosCommit: '2'.repeat(40),
        sourceDateEpoch: 1_700_000_000,
        toolchain: 'arm-none-eabi-gcc 13.2.1',
        reproducibleCleanBuilds: true,
        simulationQualification: 'passed',
      },
      transportIntegrity: 'local-manifest-sha256',
    } as const;
    expect(localCustomFirmwareTargetSchema.safeParse(target).success).toBe(true);
    expect(localCustomFirmwareTargetSchema.safeParse({ ...target, qualificationEvidenceSha256: undefined }).success).toBe(false);
    expect(localCustomFirmwareTargetSchema.safeParse({
      ...target,
      hardwareQualification: 'unqualified',
    }).success).toBe(false);
    expect(localCustomFirmwareTargetSchema.safeParse({ ...target, targetId: `custom-zs407-${'f'.repeat(64)}` }).success).toBe(false);
    expect(localCustomFirmwareTargetSchema.safeParse({ ...target, version: OEM_ZS407_FIRMWARE_RELEASE.version }).success).toBe(false);
    expect(localCustomFirmwareTargetSchema.safeParse({ ...target, revision: OEM_ZS407_FIRMWARE_RELEASE.revision }).success).toBe(false);
    const sameReportedLabels = {
      phase: 'verified' as const,
      target,
      targetRelation: 'custom-current' as const,
      writeIntent: 'install-custom' as const,
      updateAvailable: true,
      current: { version: target.version, revision: target.revision, qualification: 'custom-unqualified' as const },
      artifact: { targetId: target.targetId, sizeBytes: target.sizeBytes, sha256: target.sha256, verifiedAt: new Date().toISOString() },
      dfuUtility: { available: false },
      dfuDevice: { detected: false, count: 0 },
      writeDisposition: 'not-started' as const,
    };
    expect(firmwareUpdateStateSchema.safeParse(sameReportedLabels).success).toBe(true);
    expect(firmwareUpdateStateSchema.safeParse({
      ...sameReportedLabels,
      phase: 'up-to-date',
      targetRelation: 'same',
      writeIntent: undefined,
      updateAvailable: false,
    }).success).toBe(false);
  });
});
