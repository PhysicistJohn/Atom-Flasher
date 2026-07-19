// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import {
  OEM_ZS407_FIRMWARE_RELEASE,
  OEM_ZS407_SELF_TEST_PROCEDURE,
  canonicalDfuFingerprint,
  initialFirmwareUpdateState,
  type DeviceSnapshot,
  type FirmwareUpdateState,
  type PortCandidate,
} from '../src/core/contracts.js';
import { applicationSnapshotSchema, deriveAllowedActions, type ApplicationActionResult, type ApplicationSnapshot } from '../src/application/application-contract.js';
import { IPC_CAPABILITIES, type TinySaFlasherApi } from '../src/main/ipc-contract.js';
import { App } from '../src/renderer/App.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const exact: PortCandidate = { id: 'exact', path: '/dev/tty.exact', vendorId: '0483', productId: '5740', serialNumber: 'CDC407', usbMatch: 'exact-zs407-cdc' };
const rejected: PortCandidate = { id: 'other', path: '/dev/tty.other', vendorId: '1234', productId: '5678', usbMatch: 'unverified-serial' };

describe('standalone flasher renderer', () => {
  it('separates eligible and rejected serial devices before connection', async () => {
    installApi([exact, rejected], { connection: 'disconnected' }, initialFirmwareUpdateState());
    render(<App/>);
    expect(await screen.findByText('/dev/tty.exact')).toBeTruthy();
    expect(screen.getByText('/dev/tty.other')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Connect & verify' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('BLOCKED')).toBeTruthy();
  });

  it('offers no write when the exact connected device is already current', async () => {
    const connected = connectedSnapshot();
    const state: FirmwareUpdateState = {
      ...initialFirmwareUpdateState(),
      phase: 'up-to-date',
      targetRelation: 'same',
      current: { version: 'tinySA4_v1.4-224-gc979386', revision: 'c979386', sourceCommit: 'c97938697b6c7485e7cab50bca9af76996b7d671', qualification: 'supported-oem' },
    };
    installApi([exact], connected, state);
    render(<App/>);
    expect(await screen.findByText('Selected firmware is already installed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Install verified|Restore verified/i })).toBeNull();
  });

  it('shows a runtime serial fault and suppresses reconnect controls until safe disconnect is retried', async () => {
    installApi([exact], { connection: 'faulted', fault: 'RF output off remains unconfirmed' }, initialFirmwareUpdateState());
    render(<App/>);
    expect(await screen.findByRole('button', { name: 'Retry safe disconnect' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Resolve after physical power-off/i })).toBeTruthy();
    expect(screen.getByText('RF output off remains unconfirmed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect & verify' })).toBeNull();
  });

  it('exposes target-aware native selection without a renderer path capability', async () => {
    installApi([exact], connectedSnapshot(), customVerifiedUpdate());
    render(<App/>);

    expect(await screen.findByText('Manifested local custom build')).toBeTruthy();
    expect(screen.getByText(/No filesystem path is accepted from or returned to the renderer/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use pinned OEM target' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Select Atom-Firmware build…' })).toBeTruthy();
    expect(screen.getByText('LOCAL CUSTOM FIRMWARE')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Download & verify/i })).toBeNull();
  });

  it('labels the final custom write action distinctly from every OEM action', async () => {
    installApi([exact], { connection: 'disconnected' }, customReadyToFlashUpdate());
    render(<App/>);

    expect(await screen.findByText('LOCAL CUSTOM TARGET')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Install verified custom firmware' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /OEM firmware|OEM update/i })).toBeNull();
  });

  it('clears physical attestations when full target metadata changes even if artifact identity is unchanged', async () => {
    const controls = installApi([exact], connectedSnapshot(), customVerifiedUpdate('c'.repeat(64)));
    render(<App/>);
    await screen.findByText('Physical preflight');

    fireEvent.click(screen.getByLabelText('CAL↔RF self-test passed'));
    fireEvent.click(screen.getByLabelText('CAL and RF connectors are disconnected'));
    fireEvent.click(screen.getByLabelText('This tinySA is the only device connected for the update'));
    fireEvent.change(screen.getByLabelText('Configuration disposition'), { target: { value: 'new-device-unchanged' } });
    expect((screen.getByRole('button', { name: 'Record preflight & disconnect' }) as HTMLButtonElement).disabled).toBe(false);

    controls.setUpdate(customVerifiedUpdate('e'.repeat(64)));
    fireEvent.click(screen.getByRole('button', { name: 'Select Atom-Firmware build…' }));

    await waitFor(() => expect((screen.getByLabelText('CAL↔RF self-test passed') as HTMLInputElement).checked).toBe(false));
    expect((screen.getByRole('button', { name: 'Record preflight & disconnect' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('lets an abnormal unprepared custom recovery reconnect without enabling prepare or download', async () => {
    installApi([exact], { connection: 'disconnected' }, customFailedUnpreparedUpdate());
    render(<App/>);

    expect(await screen.findByText('/dev/tty.exact')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect & verify' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Abandon custom target and use pinned OEM target' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Record preflight|Download & verify/i })).toBeNull();
  });

  it('keeps reconnect enabled after an unprepared OEM failure', async () => {
    installApi([exact], { connection: 'disconnected' }, failedOemUnpreparedUpdate());
    render(<App/>);

    const connect = await screen.findByRole('button', { name: 'Connect & verify' });
    expect((connect as HTMLButtonElement).disabled).toBe(false);
  });

  it('offers only pathless target recovery after an abnormal custom state reconnects', async () => {
    installApi([exact], connectedSnapshot(), customFailedUnpreparedUpdate(true));
    render(<App/>);

    expect(await screen.findByRole('button', { name: 'Select Atom-Firmware build…' })).toBeTruthy();
    expect(screen.getByText(/No filesystem path is accepted from or returned to the renderer/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Record preflight|Download & verify|Retry download/i })).toBeNull();
  });
});

function installApi(devices: readonly PortCandidate[], device: DeviceSnapshot, update: FirmwareUpdateState) {
  let currentDevice = device;
  let currentUpdate = update;
  let sequence = 0;
  let candidates: readonly PortCandidate[] = [];
  const snapshot = (): ApplicationSnapshot => {
    const activity = { criticalSection: 'none' as const, admission: 'accepting' as const };
    return applicationSnapshotSchema.parse({
      schemaVersion: 2,
      instanceId: '33333333-3333-4333-8333-333333333333',
      sequence: ++sequence,
      capturedAt: '2026-07-14T16:00:00.000Z',
      activity,
      discovery: { candidates, ...(candidates.length > 0 ? { scannedAt: '2026-07-14T16:00:00.000Z' } : {}) },
      device: currentDevice,
      update: currentUpdate,
      allowedActions: deriveAllowedActions(currentDevice, currentUpdate, activity),
    });
  };
  const completed = (): ApplicationActionResult => ({ outcome: 'completed', snapshot: snapshot() });
  const cancelled = (): ApplicationActionResult => ({ outcome: 'cancelled', snapshot: snapshot() });
  const api: TinySaFlasherApi = {
    capabilities: vi.fn().mockResolvedValue(IPC_CAPABILITIES),
    snapshot: vi.fn(async () => snapshot()),
    scanDevices: vi.fn(async () => { candidates = devices; return completed(); }),
    connectDevice: vi.fn(async () => completed()),
    disconnectDevice: vi.fn(async () => completed()),
    recoverDevice: vi.fn(async () => completed()),
    selectOemTarget: vi.fn(async () => completed()),
    selectLocalFirmwareTarget: vi.fn(async () => cancelled()),
    download: vi.fn(async () => completed()),
    prepare: vi.fn(async () => completed()),
    detectDfu: vi.fn(async () => completed()),
    refreshPrerequisites: vi.fn(async () => completed()),
    flash: vi.fn(async () => cancelled()),
  };
  Object.defineProperty(window, 'tinySaFlasher', { configurable: true, value: api });
  return {
    api,
    setDevice(value: DeviceSnapshot) { currentDevice = value; },
    setUpdate(value: FirmwareUpdateState) { currentUpdate = value; },
  };
}

function connectedSnapshot(): DeviceSnapshot {
  return {
    connection: 'ready',
    connectedAt: '2026-07-14T16:00:00.000Z',
    telemetry: { batteryMillivolts: 4211, deviceId: 407, capturedAt: '2026-07-14T16:00:00.000Z' },
    identity: {
      model: 'tinySA Ultra+ ZS407', hardwareVersion: 'V0.5.4 + ZS407', firmwareVersion: 'tinySA4_v1.4-224-gc979386',
      firmwareReportedRevision: 'c979386', firmwareSourceCommit: 'c97938697b6c7485e7cab50bca9af76996b7d671', firmwareQualification: 'supported-oem',
      port: exact, usbIdentityVerified: true,
    },
  };
}

function customVerifiedUpdate(manifestSha256 = 'c'.repeat(64)): FirmwareUpdateState {
  const target = customTarget(manifestSha256);
  return {
    ...initialFirmwareUpdateState(target),
    phase: 'verified',
    current: {
      version: OEM_ZS407_FIRMWARE_RELEASE.version,
      revision: OEM_ZS407_FIRMWARE_RELEASE.revision,
      sourceCommit: OEM_ZS407_FIRMWARE_RELEASE.sourceCommit,
      qualification: 'supported-oem',
    },
    targetRelation: 'different-supported',
    writeIntent: 'install-custom',
    updateAvailable: true,
    artifact: {
      targetId: target.targetId,
      sizeBytes: target.sizeBytes,
      sha256: target.sha256,
      verifiedAt: '2026-07-14T16:00:00.000Z',
    },
  };
}

function customReadyToFlashUpdate(): FirmwareUpdateState {
  const base = customVerifiedUpdate();
  const identity = {
    path: '1-1',
    devnum: '5',
    serial: 'DFU407',
    alt: 0 as const,
    name: '@Internal Flash /0x08000000/128*002Kg',
  };
  return {
    ...base,
    phase: 'ready-to-flash',
    preparation: {
      id: 'a5ada7f3-fbe3-41bd-83ac-a07028bc55f6',
      preparedAt: '2026-07-14T16:00:00.000Z',
      batteryMillivolts: 4_211,
      deviceId: 407,
      screenSha256: 'a'.repeat(64),
      selfTestPassed: true,
      selfTestProcedure: OEM_ZS407_SELF_TEST_PROCEDURE.id,
      configurationDisposition: 'new-device-unchanged',
      rfPortsDisconnected: true,
      onlyUsbDeviceConnected: true,
      usbContinuity: {
        cdcPath: exact.path,
        cdcSerialNumber: exact.serialNumber,
        vendorId: '0483',
        productId: '5740',
        deviceId: 407,
      },
    },
    dfuUtility: { available: true, version: '0.11' },
    dfuDevice: {
      detected: true,
      count: 1,
      identity: {
        ...identity,
        fingerprint: canonicalDfuFingerprint(identity),
        targetLine: `Found DFU: [0483:df11] devnum=5, path="1-1", alt=0, name="${identity.name}", serial="DFU407"`,
      },
    },
  };
}

function customFailedUnpreparedUpdate(connected = false): FirmwareUpdateState {
  const target = customTarget('c'.repeat(64));
  return {
    ...initialFirmwareUpdateState(target),
    phase: 'failed',
    ...(connected ? {
      current: {
        version: OEM_ZS407_FIRMWARE_RELEASE.version,
        revision: OEM_ZS407_FIRMWARE_RELEASE.revision,
        sourceCommit: OEM_ZS407_FIRMWARE_RELEASE.sourceCommit,
        qualification: 'supported-oem' as const,
      },
      targetRelation: 'different-supported' as const,
      writeIntent: 'install-custom' as const,
      updateAvailable: true,
    } : {}),
    error: 'Recovered custom target requires exact native manifest re-admission',
  };
}

function failedOemUnpreparedUpdate(): FirmwareUpdateState {
  return {
    ...initialFirmwareUpdateState(),
    phase: 'failed',
    current: {
      version: 'tinySA4_v1.4-217-gc5dd31f',
      revision: 'c5dd31f',
      sourceCommit: 'c5dd31fd4679c15ba92ff46a6e258c1e3516ff0c',
      qualification: 'supported-oem',
    },
    targetRelation: 'different-supported',
    writeIntent: 'update-oem',
    updateAvailable: true,
    error: 'OEM download verification failed before preparation',
  };
}

function customTarget(manifestSha256: string) {
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
    manifestSha256,
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
