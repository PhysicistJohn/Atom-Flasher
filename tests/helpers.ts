/**
 * Shared fixtures for the safety-chain test suite: a fake ZS407 device, a
 * deterministic updater runtime, and a locally built custom-target fixture.
 */
import { createHash } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import {
  OEM_ZS407_FIRMWARE_RELEASE,
  OEM_ZS407_SELF_TEST_PROCEDURE,
  SCREEN_BYTES,
  ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT,
  type DeviceDiagnostics,
  type DeviceSnapshot,
  type LocalCustomFirmwareTarget,
  type PortCandidate,
  type ScreenFrame,
} from '../src/core/contracts.js';
import {
  FirmwareUpdater,
  type AdmittedFirmwareArtifact,
  type DfuExecutionResult,
  type FirmwareUpdateDevice,
  type FirmwareUpdaterRuntime,
} from '../src/core/firmware-updater.js';

export const cdcCandidate: PortCandidate = {
  id: '/dev/tty.CDC407:CDC407:0483:5740', path: '/dev/tty.CDC407', vendorId: '0483', productId: '5740', serialNumber: 'CDC407', usbMatch: 'exact-zs407-cdc',
};

export const dfuLine = 'Found DFU: [0483:df11] ver=2200, devnum=5, cfg=1, intf=0, path="1-1", alt=0, name="@Internal Flash  /0x08000000/128*002Kg", serial="DFU407"';

const directories: string[] = [];

export async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tinysa-flasher-test-'));
  directories.push(directory);
  return directory;
}

export async function removeTemporaryDirectories(): Promise<void> {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
}

export async function present(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export function successfulTransfer(): DfuExecutionResult {
  return { stdout: 'Download done.\nFile downloaded successfully', stderr: '', outputTruncated: false, exceededExpectedDuration: false };
}

export function validPreflight() {
  return {
    selfTestPassed: true as const,
    selfTestProcedure: OEM_ZS407_SELF_TEST_PROCEDURE.id,
    configurationDisposition: 'new-device-unchanged' as const,
    rfPortsDisconnected: true as const,
    onlyUsbDeviceConnected: true as const,
  };
}

export function runtimeFixture(runDfuExecutable: FirmwareUpdaterRuntime['runDfuExecutable']): Partial<FirmwareUpdaterRuntime> {
  return {
    fetch: async () => new Response(new Uint8Array(OEM_ZS407_FIRMWARE_RELEASE.sizeBytes), { status: 200, headers: { 'content-length': String(OEM_ZS407_FIRMWARE_RELEASE.sizeBytes) } }),
    locateDfuUtility: async () => '/fixture/dfu-util',
    runExecutable: async (_file, args) => args.includes('--version') ? { stdout: 'dfu-util 0.11', stderr: '' } : { stdout: dfuLine, stderr: '' },
    runDfuExecutable,
    verifyArtifact: () => undefined,
    delay: async () => undefined,
  };
}

/** Drives a fresh updater to ready-to-flash against the fake device. */
export async function readyFixture(
  device: FakeFirmwareDevice,
  runDfuExecutable: FirmwareUpdaterRuntime['runDfuExecutable'],
  runtimeOverrides: Partial<FirmwareUpdaterRuntime> = {},
): Promise<{ directory: string; updater: FirmwareUpdater; runtime: Partial<FirmwareUpdaterRuntime>; preparationId: string }> {
  const directory = await temporaryDirectory();
  const runtime = { ...runtimeFixture(runDfuExecutable), ...runtimeOverrides };
  const updater = new FirmwareUpdater(directory, device, runtime);
  expect(await updater.state()).toMatchObject({ phase: 'available', updateAvailable: true });
  expect(await updater.download()).toMatchObject({ phase: 'verified', artifact: { sizeBytes: OEM_ZS407_FIRMWARE_RELEASE.sizeBytes } });
  const prepared = await updater.prepare(validPreflight());
  const preparationId = prepared.preparation!.id;
  expect(prepared.phase).toBe('awaiting-dfu');
  expect(await updater.detectDfu()).toMatchObject({ phase: 'ready-to-flash', dfuDevice: { identity: { path: '1-1', serial: 'DFU407' } } });
  return { directory, updater, runtime, preparationId };
}

export function customArtifactFixture(): {
  target: LocalCustomFirmwareTarget;
  artifact: AdmittedFirmwareArtifact;
  bytes: Uint8Array;
} {
  const bytes = new Uint8Array(8 * 1024).fill(0x5a);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const target: LocalCustomFirmwareTarget = {
    kind: 'local-custom',
    targetId: `custom-zs407-${sha256}`,
    product: OEM_ZS407_FIRMWARE_RELEASE.product,
    version: 'tinySA4_dev-225-g1111111',
    revision: '1111111',
    sourceCommit: `1111111${'1'.repeat(33)}`,
    sha256,
    sizeBytes: bytes.byteLength,
    manifestSha256: 'b'.repeat(64),
    hardwareQualification: 'qualified',
    qualificationEvidenceSha256: 'd'.repeat(64),
    buildProvenance: {
      sourceRepository: 'PhysicistJohn/TinySA_Firmware',
      chibiosCommit: 'c'.repeat(40),
      sourceDateEpoch: 1_700_000_000,
      toolchain: 'arm-none-eabi-gcc 13.2.1',
      reproducibleCleanBuilds: true,
      simulationQualification: 'passed',
    },
    transportIntegrity: 'local-manifest-sha256',
  };
  return {
    target,
    bytes,
    artifact: Object.freeze({
      targetId: target.targetId,
      openVerified: async () => fakeVerifiedArtifact(new Uint8Array(bytes)),
    }),
  };
}

export function fakeVerifiedArtifact(bytes: Uint8Array) {
  return {
    descriptor: 41,
    bytes,
    assertStable: async () => undefined,
    close: async () => undefined,
  };
}

export class FakeFirmwareDevice implements FirmwareUpdateDevice {
  #snapshot: DeviceSnapshot;
  constructor(private readonly options: {
    batteryMillivolts?: number;
    disconnected?: boolean;
    postFlashCustomTarget?: LocalCustomFirmwareTarget;
    postFlashDeviceId?: number;
  } = {}) {
    this.#snapshot = options.disconnected
      ? { connection: 'disconnected' }
      : outdatedSnapshot(options.batteryMillivolts);
  }
  snapshot(): DeviceSnapshot { return structuredClone(this.#snapshot); }
  async readDiagnostics(): Promise<DeviceDiagnostics> {
    const identity = this.#snapshot.identity ?? outdatedSnapshot().identity!;
    return {
      identity,
      firmwareVersionResponse: identity.firmwareVersion,
      infoLines: ['tinySA ULTRA+ ZS407'],
      commands: ['version', 'info', 'help', 'mode', 'output', 'vbat', 'deviceid', 'capture'],
      telemetry: {
        batteryMillivolts: this.options.batteryMillivolts ?? 4211,
        deviceId: 407,
        capturedAt: new Date().toISOString(),
      },
      capturedAt: new Date().toISOString(),
    };
  }
  async captureScreen(): Promise<ScreenFrame> {
    return { width: 480, height: 320, format: 'rgb565le', pixels: new Uint8Array(SCREEN_BYTES), capturedAt: new Date().toISOString() };
  }
  async disconnect(): Promise<void> { this.#snapshot = { connection: 'disconnected' }; }
  async listDevices(): Promise<PortCandidate[]> { return [structuredClone(cdcCandidate)]; }
  async connect(candidate: PortCandidate): Promise<DeviceSnapshot> {
    this.#snapshot = this.options.postFlashCustomTarget
      ? customSnapshot(candidate, this.options.postFlashCustomTarget, this.options.postFlashDeviceId ?? 407)
      : targetSnapshot(candidate, this.options.postFlashDeviceId ?? 407);
    return this.snapshot();
  }
}

function outdatedSnapshot(batteryMillivolts = 4211): DeviceSnapshot {
  const capturedAt = new Date().toISOString();
  return {
    connection: 'ready',
    identity: {
      model: 'tinySA Ultra+ ZS407', hardwareVersion: 'V0.5.4 + ZS407', firmwareVersion: 'tinySA4_v1.4-217-gc5dd31f',
      firmwareReportedRevision: 'c5dd31f', firmwareSourceCommit: ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT, firmwareQualification: 'supported-oem',
      port: cdcCandidate, usbIdentityVerified: true,
    },
    telemetry: { batteryMillivolts, deviceId: 407, capturedAt },
    connectedAt: capturedAt,
  };
}

function targetSnapshot(candidate: PortCandidate, deviceId: number): DeviceSnapshot {
  const capturedAt = new Date().toISOString();
  return {
    connection: 'ready',
    identity: {
      model: 'tinySA Ultra+ ZS407', hardwareVersion: 'V0.5.4 + ZS407', firmwareVersion: OEM_ZS407_FIRMWARE_RELEASE.version,
      firmwareReportedRevision: OEM_ZS407_FIRMWARE_RELEASE.revision, firmwareSourceCommit: OEM_ZS407_FIRMWARE_RELEASE.sourceCommit, firmwareQualification: 'supported-oem',
      port: candidate, usbIdentityVerified: true,
    },
    telemetry: { batteryMillivolts: 4211, deviceId, capturedAt },
    connectedAt: capturedAt,
  };
}

function customSnapshot(candidate: PortCandidate, target: LocalCustomFirmwareTarget, deviceId: number): DeviceSnapshot {
  const capturedAt = new Date().toISOString();
  return {
    connection: 'ready',
    identity: {
      model: 'tinySA Ultra+ ZS407', hardwareVersion: 'V0.5.4 + ZS407', firmwareVersion: target.version,
      firmwareReportedRevision: target.revision, firmwareQualification: 'custom-unqualified', firmwareWarning: 'Locally built custom firmware',
      port: candidate, usbIdentityVerified: true,
    },
    telemetry: { batteryMillivolts: 4211, deviceId, capturedAt },
    connectedAt: capturedAt,
  };
}
