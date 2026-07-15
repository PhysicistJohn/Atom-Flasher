import { describe, expect, it } from 'vitest';
import {
  OEM_ZS407_FIRMWARE_RELEASE,
  ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT,
  ZS407_SHIPPED_FIRMWARE_VERSION,
  initialFirmwareUpdateState,
  type DeviceSnapshot,
  type FirmwareUpdateState,
  type PortCandidate,
} from '../src/core/contracts.js';
import {
  applicationSnapshotSchema,
  deriveAllowedActions,
  type AllowedActions,
  type ApplicationActivity,
} from '../src/application/application-contract.js';

const exactPort: PortCandidate = {
  id: '/dev/tty.fixture:CDC407:0483:5740',
  path: '/dev/tty.fixture',
  serialNumber: 'CDC407',
  vendorId: '0483',
  productId: '5740',
  usbMatch: 'exact-zs407-cdc',
};

describe('application allowed-action policy', () => {
  it.each([
    ['disconnected idle', disconnected(), initialFirmwareUpdateState(), idleActivity(), ['scanDevices', 'connectDevice']],
    ['disconnected recoverable OEM failure', disconnected(), failedOemUnpreparedUpdate(), idleActivity(), ['scanDevices', 'connectDevice']],
    ['disconnected recoverable custom admission', disconnected(), customFailedUnpreparedUpdate(), idleActivity(), ['scanDevices', 'connectDevice', 'selectOemTarget']],
    ['ready outdated device', readyDevice(), availableUpdate(), idleActivity(), ['disconnectDevice', 'selectLocalFirmwareTarget', 'download']],
    ['verified artifact', readyDevice(), verifiedUpdate(), idleActivity(), ['disconnectDevice', 'selectLocalFirmwareTarget', 'prepare']],
    ['verified custom artifact', readyDevice(), customVerifiedUpdate(), idleActivity(), ['disconnectDevice', 'selectOemTarget', 'selectLocalFirmwareTarget', 'prepare']],
    ['connected recoverable custom admission', readyDevice(), customFailedUnpreparedUpdate(true), idleActivity(), ['disconnectDevice', 'selectOemTarget', 'selectLocalFirmwareTarget']],
    ['awaiting DFU', disconnected(), awaitingDfuUpdate(), idleActivity(), ['detectDfu', 'refreshPrerequisites']],
    ['prepared custom target', disconnected(), customAwaitingDfuUpdate(), idleActivity(), ['selectLocalFirmwareTarget', 'detectDfu', 'refreshPrerequisites']],
    ['unbound recovered prepared custom target', disconnected(), customFailedPreparedUpdate(), idleActivity(), ['selectLocalFirmwareTarget']],
    ['admitted DFU target', disconnected(), readyToFlashUpdate(), idleActivity(), ['refreshPrerequisites', 'flash']],
    ['admitted custom DFU target', disconnected(), customReadyToFlashUpdate(), idleActivity(), ['selectLocalFirmwareTarget', 'refreshPrerequisites', 'flash']],
    ['custom write started', disconnected(), customFlashingUpdate(), idleActivity(), []],
    ['fault requiring recovery', faultedDevice(), failedPreparedUpdate(), idleActivity(), ['disconnectDevice', 'recoverDevice', 'refreshPrerequisites']],
    ['active operation', disconnected(), initialFirmwareUpdateState(), { ...idleActivity(), operation: 'scan-devices' as const }, []],
    ['native confirmation', disconnected(), initialFirmwareUpdateState(), { ...idleActivity(), criticalSection: 'native-confirmation' as const }, []],
    ['native file selection', readyDevice(), availableUpdate(), { ...idleActivity(), criticalSection: 'native-file-selection' as const }, []],
    ['write verification', disconnected(), readyToFlashUpdate(), { ...idleActivity(), criticalSection: 'firmware-write-or-verification' as const }, []],
    ['draining shutdown', disconnected(), initialFirmwareUpdateState(), { ...idleActivity(), admission: 'draining' as const }, []],
    ['closed application', disconnected(), initialFirmwareUpdateState(), { ...idleActivity(), admission: 'closed' as const }, []],
  ] satisfies ReadonlyArray<readonly [string, DeviceSnapshot, FirmwareUpdateState, ApplicationActivity, readonly (keyof AllowedActions)[]]>) (
    'enables only the intended actions for %s',
    (_label, device, update, activity, expected) => {
      expect(enabledActions(deriveAllowedActions(device, update, activity))).toEqual(expected);
    },
  );

  it('rejects a snapshot whose advertised actions differ from derived policy', () => {
    const device = readyDevice();
    const update = availableUpdate();
    const activity = idleActivity();
    const allowedActions = deriveAllowedActions(device, update, activity);
    const valid = {
      schemaVersion: 2,
      instanceId: '33333333-3333-4333-8333-333333333333',
      sequence: 1,
      capturedAt: '2026-07-14T16:00:00.000Z',
      activity,
      discovery: { candidates: [] },
      device,
      update,
      allowedActions,
    };

    expect(applicationSnapshotSchema.safeParse(valid).success).toBe(true);
    expect(applicationSnapshotSchema.safeParse({
      ...valid,
      allowedActions: { ...allowedActions, flash: true },
    }).success).toBe(false);
  });
});

function enabledActions(actions: AllowedActions): (keyof AllowedActions)[] {
  return (Object.keys(actions) as (keyof AllowedActions)[]).filter((key) => actions[key]);
}

function idleActivity(): ApplicationActivity {
  return { criticalSection: 'none', admission: 'accepting' };
}

function disconnected(): DeviceSnapshot { return { connection: 'disconnected' }; }
function faultedDevice(): DeviceSnapshot { return { connection: 'faulted', fault: 'RF output-off acknowledgement is uncertain' }; }

function readyDevice(): DeviceSnapshot {
  return {
    connection: 'ready',
    connectedAt: '2026-07-14T15:59:00.000Z',
    telemetry: { batteryMillivolts: 4_200, deviceId: 407, capturedAt: '2026-07-14T16:00:00.000Z' },
    identity: {
      model: 'tinySA Ultra+ ZS407',
      hardwareVersion: 'V0.5.4 + ZS407',
      firmwareVersion: ZS407_SHIPPED_FIRMWARE_VERSION,
      firmwareReportedRevision: 'c5dd31f',
      firmwareSourceCommit: ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT,
      firmwareQualification: 'supported-oem',
      port: exactPort,
      usbIdentityVerified: true,
    },
  };
}

function availableUpdate(): FirmwareUpdateState {
  return {
    ...initialFirmwareUpdateState(),
    phase: 'available',
    targetRelation: 'different-supported',
    writeIntent: 'update-oem',
    updateAvailable: true,
    current: shippedCurrent(),
  };
}

function failedOemUnpreparedUpdate(): FirmwareUpdateState {
  return {
    ...availableUpdate(),
    phase: 'failed',
    error: 'OEM download verification failed before preparation',
  };
}

function verifiedUpdate(): FirmwareUpdateState {
  return { ...availableUpdate(), phase: 'verified', artifact: artifact() };
}

function awaitingDfuUpdate(): FirmwareUpdateState {
  return { ...verifiedUpdate(), phase: 'awaiting-dfu', preparation: preparation() };
}

function readyToFlashUpdate(): FirmwareUpdateState {
  return {
    ...awaitingDfuUpdate(),
    phase: 'ready-to-flash',
    dfuUtility: { available: true, version: '0.11' },
    dfuDevice: { detected: true, count: 1, identity: dfuIdentity() },
  };
}

function customVerifiedUpdate(): FirmwareUpdateState {
  const target = customTarget();
  return {
    ...initialFirmwareUpdateState(target),
    phase: 'verified',
    current: shippedCurrent(),
    targetRelation: 'different-supported',
    writeIntent: 'install-custom',
    updateAvailable: true,
    artifact: {
      targetId: target.targetId,
      sizeBytes: target.sizeBytes,
      sha256: target.sha256,
      verifiedAt: '2026-07-14T15:55:00.000Z',
    },
  };
}

function customFailedUnpreparedUpdate(connected = false): FirmwareUpdateState {
  const target = customTarget();
  return {
    ...initialFirmwareUpdateState(target),
    phase: 'failed',
    ...(connected ? {
      current: shippedCurrent(),
      targetRelation: 'different-supported' as const,
      writeIntent: 'install-custom' as const,
      updateAvailable: true,
    } : {}),
    error: 'Recovered custom target requires exact native manifest re-admission',
  };
}

function customAwaitingDfuUpdate(): FirmwareUpdateState {
  return { ...customVerifiedUpdate(), phase: 'awaiting-dfu', preparation: preparation() };
}

function customFailedPreparedUpdate(): FirmwareUpdateState {
  return {
    ...customAwaitingDfuUpdate(),
    phase: 'failed',
    error: 'Recovered prepared custom target requires exact native manifest re-admission',
  };
}

function customReadyToFlashUpdate(): FirmwareUpdateState {
  return {
    ...customAwaitingDfuUpdate(),
    phase: 'ready-to-flash',
    dfuUtility: { available: true, version: '0.11' },
    dfuDevice: { detected: true, count: 1, identity: dfuIdentity() },
  };
}

function customFlashingUpdate(): FirmwareUpdateState {
  return {
    ...customReadyToFlashUpdate(),
    phase: 'flashing',
    writeDisposition: 'started',
    writeStartedAt: '2026-07-14T16:01:00.000Z',
    flashProgress: { stage: 'preparing', percent: 0, updatedAt: '2026-07-14T16:01:00.000Z' },
  };
}

function customTarget() {
  const sha256 = 'b'.repeat(64);
  return {
    kind: 'local-custom' as const,
    targetId: `custom-zs407-${sha256}`,
    product: OEM_ZS407_FIRMWARE_RELEASE.product,
    version: 'tinySA4_local-gabcdef0',
    revision: 'abcdef0',
    sourceCommit: `abcdef0${'0'.repeat(33)}`,
    sha256,
    sizeBytes: 8_192,
    manifestSha256: 'c'.repeat(64),
    hardwareQualification: 'unqualified' as const,
    buildProvenance: {
      sourceRepository: 'PhysicistJohn/TinySA_Firmware' as const,
      chibiosCommit: 'd'.repeat(40),
      sourceDateEpoch: 1_700_000_000,
      toolchain: 'arm-none-eabi-gcc fixture',
      reproducibleCleanBuilds: true as const,
      simulationQualification: 'not-run' as const,
    },
    transportIntegrity: 'local-manifest-sha256' as const,
  };
}

function failedPreparedUpdate(): FirmwareUpdateState {
  return {
    ...awaitingDfuUpdate(),
    phase: 'failed',
    error: 'DFU enumeration was interrupted',
  };
}

function shippedCurrent() {
  return {
    version: ZS407_SHIPPED_FIRMWARE_VERSION,
    revision: 'c5dd31f' as const,
    sourceCommit: ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT,
    qualification: 'supported-oem' as const,
  };
}

function artifact() {
  return {
    sizeBytes: OEM_ZS407_FIRMWARE_RELEASE.sizeBytes,
    sha256: OEM_ZS407_FIRMWARE_RELEASE.sha256,
    verifiedAt: '2026-07-14T15:55:00.000Z',
  };
}

function preparation() {
  return {
    id: 'a5ada7f3-fbe3-41bd-83ac-a07028bc55f6',
    preparedAt: '2026-07-14T15:58:00.000Z',
    batteryMillivolts: 4_200,
    deviceId: 407,
    screenSha256: 'a'.repeat(64),
    selfTestPassed: true as const,
    selfTestProcedure: 'tinySA4-zs407-cal-rf-v1' as const,
    configurationDisposition: 'new-device-unchanged' as const,
    rfPortsDisconnected: true as const,
    onlyUsbDeviceConnected: true as const,
    usbContinuity: {
      cdcPath: exactPort.path,
      cdcSerialNumber: exactPort.serialNumber,
      vendorId: '0483' as const,
      productId: '5740' as const,
      deviceId: 407,
    },
  };
}

function dfuIdentity() {
  const identity = {
    path: '1-1',
    devnum: '5',
    serial: 'DFU407',
    alt: 0 as const,
    name: '@Internal Flash /0x08000000/128*002Kg',
  };
  return {
    ...identity,
    fingerprint: JSON.stringify(identity),
    targetLine: `Found DFU: [0483:df11] devnum=5, path="1-1", alt=0, name="${identity.name}", serial="DFU407"`,
  };
}
