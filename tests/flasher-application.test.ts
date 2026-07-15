import { describe, expect, it, vi } from 'vitest';
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
  FlasherApplication,
  type ApplicationDevicePort,
  type ApplicationUpdaterPort,
  type NativeSafetyPromptPort,
} from '../src/application/flasher-application.js';

const exactPort: PortCandidate = {
  id: '/dev/tty.fixture:CDC407:0483:5740',
  path: '/dev/tty.fixture',
  serialNumber: 'CDC407',
  vendorId: '0483',
  productId: '5740',
  usbMatch: 'exact-zs407-cdc',
};

describe('flasher application coordinator', () => {
  it('returns atomic composite snapshots with a stable instance and monotonic sequence', async () => {
    const harness = createHarness();
    const initial = await harness.application.initialize();
    const scanned = await harness.application.scanDevices();
    harness.setUpdate(availableUpdate());
    const connected = await harness.application.connectDevice(exactPort);
    const observed = harness.application.snapshot();

    const sequences = [initial.sequence, scanned.snapshot.sequence, connected.snapshot.sequence, observed.sequence];
    expect(sequences.every((sequence, index) => index === 0 || sequence > sequences[index - 1]!)).toBe(true);
    expect(new Set([initial.instanceId, scanned.snapshot.instanceId, connected.snapshot.instanceId, observed.instanceId]).size).toBe(1);
    expect(scanned.snapshot.discovery).toMatchObject({ candidates: [exactPort], scannedAt: expect.any(String) });
    expect(connected.snapshot).toMatchObject({
      activity: { criticalSection: 'none', admission: 'accepting' },
      device: { connection: 'ready', identity: { port: exactPort } },
      update: { phase: 'available', updateAvailable: true },
      allowedActions: { disconnectDevice: true, download: true },
    });
    expect(harness.state).toHaveBeenCalledTimes(2);
  });

  it('rejects overlapping operations while snapshots remain observable and non-actionable', async () => {
    const harness = createHarness();
    await harness.application.initialize();
    const listing = deferred<PortCandidate[]>();
    harness.listDevices.mockImplementationOnce(() => listing.promise);

    const scan = harness.application.scanDevices();
    await waitUntil(() => harness.application.activeOperation === 'scan-devices');
    const during = harness.application.snapshot();
    expect(during.activity.operation).toBe('scan-devices');
    expect(Object.values(during.allowedActions).every((allowed) => !allowed)).toBe(true);
    await expect(harness.application.download()).rejects.toThrow(/scan-devices is already active/i);
    expect(harness.download).not.toHaveBeenCalled();

    listing.resolve([exactPort]);
    await expect(scan).resolves.toMatchObject({ outcome: 'completed' });
    expect(harness.application.activeOperation).toBeUndefined();
  });

  it('allows a disconnected unprepared OEM failure to scan and reconnect for retry', async () => {
    const harness = createHarness({ update: failedOemUnpreparedUpdate() });
    await harness.application.initialize();

    const scanned = await harness.application.scanDevices();
    const connected = await harness.application.connectDevice(exactPort);

    expect(scanned.snapshot.allowedActions.connectDevice).toBe(true);
    expect(connected.outcome).toBe('completed');
    expect(harness.connect).toHaveBeenCalledWith(exactPort);
  });

  it('keeps firmware and recovery effects untouched when native confirmation is cancelled', async () => {
    const flashHarness = createHarness({ update: readyToFlashUpdate() });
    flashHarness.confirmFirmwareWrite.mockResolvedValueOnce(false);
    await flashHarness.application.initialize();
    const flash = await flashHarness.application.flash(preparation().id);

    expect(flash).toMatchObject({ outcome: 'cancelled', snapshot: { activity: { criticalSection: 'none' } } });
    expect(flash.snapshot.allowedActions.flash).toBe(true);
    expect(flashHarness.confirmFirmwareWrite).toHaveBeenCalledWith({
      preparationId: preparation().id,
      targetId: 'oem-zs407-c979386',
      targetKind: 'oem',
      targetVersion: OEM_ZS407_FIRMWARE_RELEASE.version,
      targetSha256: OEM_ZS407_FIRMWARE_RELEASE.sha256,
    });
    expect(flashHarness.flash).not.toHaveBeenCalled();

    const recoveryHarness = createHarness({ device: faultedDevice() });
    recoveryHarness.confirmPhysicalPowerOff.mockResolvedValueOnce(false);
    await recoveryHarness.application.initialize();
    const recovery = await recoveryHarness.application.recoverDevice();
    expect(recovery.outcome).toBe('cancelled');
    expect(recoveryHarness.recoverAfterManualPowerOff).not.toHaveBeenCalled();
    expect(recoveryHarness.application.criticalSection).toBe('none');
  });

  it('blocks shutdown throughout native confirmation and the firmware write/verification section', async () => {
    const harness = createHarness({ update: readyToFlashUpdate() });
    const confirmation = deferred<boolean>();
    const write = deferred<FirmwareUpdateState>();
    harness.confirmFirmwareWrite.mockImplementationOnce(() => confirmation.promise);
    harness.flash.mockImplementationOnce(() => write.promise);
    await harness.application.initialize();

    const flashing = harness.application.flash(preparation().id);
    await waitUntil(() => harness.confirmFirmwareWrite.mock.calls.length === 1);
    expect(harness.application.criticalSection).toBe('native-confirmation');
    await expect(harness.application.requestShutdown()).resolves.toBe('blocked-critical');
    expect(harness.disconnect).not.toHaveBeenCalled();

    confirmation.resolve(true);
    await waitUntil(() => harness.flash.mock.calls.length === 1);
    expect(harness.application.criticalSection).toBe('firmware-write-or-verification');
    await expect(harness.application.releaseForWindowClose()).resolves.toBe('blocked-critical');

    write.resolve(readyToFlashUpdate());
    await expect(flashing).resolves.toMatchObject({ outcome: 'completed' });
    expect(harness.application.criticalSection).toBe('none');
  });

  it('drains an ordinary operation, rejects new admission, disconnects safely, and permanently closes', async () => {
    const harness = createHarness({ device: readyDevice(), update: availableUpdate() });
    const download = deferred<FirmwareUpdateState>();
    harness.download.mockImplementationOnce(() => download.promise);
    await harness.application.initialize();

    const activeDownload = harness.application.download();
    await waitUntil(() => harness.application.activeOperation === 'download-firmware');
    const shutdown = harness.application.requestShutdown();
    expect(harness.application.admission).toBe('draining');
    await expect(harness.application.scanDevices()).rejects.toThrow(/admission is draining/i);
    expect(harness.disconnect).not.toHaveBeenCalled();

    download.resolve(availableUpdate());
    await activeDownload;
    await expect(shutdown).resolves.toBe('safe');
    expect(harness.disconnect).toHaveBeenCalledOnce();
    expect(harness.application.admission).toBe('closed');
    await expect(harness.application.scanDevices()).rejects.toThrow(/admission is closed/i);
  });

  it('keeps admission drained after window release until the host installs a new window', async () => {
    const harness = createHarness({ device: readyDevice(), update: availableUpdate() });
    await harness.application.initialize();
    await expect(harness.application.releaseForWindowClose()).resolves.toBe('safe');
    expect(harness.disconnect).toHaveBeenCalledOnce();
    expect(harness.deviceSnapshot()).toEqual({ connection: 'disconnected' });
    expect(harness.application.admission).toBe('draining');
    await expect(harness.application.scanDevices()).rejects.toThrow(/admission is draining/i);
    harness.application.resumeAfterWindowOpen();
    expect(harness.application.admission).toBe('accepting');
    await expect(harness.application.scanDevices()).resolves.toMatchObject({ outcome: 'completed' });
  });
});

function createHarness(options: { device?: DeviceSnapshot; update?: FirmwareUpdateState } = {}) {
  let deviceValue = structuredClone(options.device ?? disconnectedDevice());
  let updateValue = structuredClone(options.update ?? initialFirmwareUpdateState());
  const candidates = [exactPort];

  const listDevices = vi.fn(async () => structuredClone(candidates));
  const deviceSnapshot = vi.fn(() => structuredClone(deviceValue));
  const connect = vi.fn(async (candidate: PortCandidate) => {
    deviceValue = readyDevice(candidate);
    return structuredClone(deviceValue);
  });
  const disconnect = vi.fn(async () => { deviceValue = disconnectedDevice(); });
  const recoverAfterManualPowerOff = vi.fn(async () => {
    deviceValue = disconnectedDevice();
    return structuredClone(deviceValue);
  });
  const device: ApplicationDevicePort = { listDevices, snapshot: deviceSnapshot, connect, disconnect, recoverAfterManualPowerOff };

  const state = vi.fn(async () => structuredClone(updateValue));
  const updaterSnapshot = vi.fn(() => structuredClone(updateValue));
  const download = vi.fn(async () => structuredClone(updateValue));
  const prepareUpdate = vi.fn(async () => structuredClone(updateValue));
  const detectDfu = vi.fn(async () => structuredClone(updateValue));
  const refreshPrerequisites = vi.fn(async () => structuredClone(updateValue));
  const flash = vi.fn(async () => structuredClone(updateValue));
  const selectOemTarget = vi.fn(async () => structuredClone(updateValue));
  const admitLocalCustomTarget = vi.fn(async () => structuredClone(updateValue));
  const updater: ApplicationUpdaterPort = {
    state,
    snapshot: updaterSnapshot,
    download,
    prepare: prepareUpdate,
    detectDfu,
    refreshPrerequisites,
    flash,
    selectOemTarget,
    admitLocalCustomTarget,
  };

  const confirmFirmwareWrite = vi.fn(async () => true);
  const confirmPhysicalPowerOff = vi.fn(async () => true);
  const prompts: NativeSafetyPromptPort = { confirmFirmwareWrite, confirmPhysicalPowerOff };
  const application = new FlasherApplication(device, updater, prompts);
  return {
    application,
    listDevices,
    deviceSnapshot,
    connect,
    disconnect,
    recoverAfterManualPowerOff,
    state,
    download,
    prepareUpdate,
    detectDfu,
    refreshPrerequisites,
    flash,
    selectOemTarget,
    admitLocalCustomTarget,
    confirmFirmwareWrite,
    confirmPhysicalPowerOff,
    setUpdate(value: FirmwareUpdateState) { updateValue = structuredClone(value); },
  };
}

function disconnectedDevice(): DeviceSnapshot { return { connection: 'disconnected' }; }
function faultedDevice(): DeviceSnapshot { return { connection: 'faulted', fault: 'RF output-off acknowledgement is uncertain' }; }

function readyDevice(port: PortCandidate = exactPort): DeviceSnapshot {
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
      port,
      usbIdentityVerified: true,
    },
  };
}

function availableUpdate(): FirmwareUpdateState {
  return {
    ...initialFirmwareUpdateState(),
    phase: 'available',
    updateAvailable: true,
    targetRelation: 'different-supported',
    writeIntent: 'update-oem',
    current: {
      version: ZS407_SHIPPED_FIRMWARE_VERSION,
      revision: 'c5dd31f',
      sourceCommit: ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT,
      qualification: 'supported-oem',
    },
  };
}

function failedOemUnpreparedUpdate(): FirmwareUpdateState {
  return {
    ...availableUpdate(),
    phase: 'failed',
    error: 'OEM download verification failed before preparation',
  };
}

function readyToFlashUpdate(): FirmwareUpdateState {
  return {
    ...availableUpdate(),
    phase: 'ready-to-flash',
    artifact: {
      sizeBytes: OEM_ZS407_FIRMWARE_RELEASE.sizeBytes,
      sha256: OEM_ZS407_FIRMWARE_RELEASE.sha256,
      verifiedAt: '2026-07-14T15:55:00.000Z',
    },
    preparation: preparation(),
    dfuUtility: { available: true, version: '0.11' },
    dfuDevice: { detected: true, count: 1, identity: dfuIdentity() },
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
  const identity = { path: '1-1', devnum: '5', serial: 'DFU407', alt: 0 as const, name: '@Internal Flash /0x08000000/128*002Kg' };
  return {
    ...identity,
    fingerprint: JSON.stringify(identity),
    targetLine: `Found DFU: [0483:df11] devnum=5, path="1-1", alt=0, name="${identity.name}", serial="DFU407"`,
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Timed out waiting for application test condition');
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
