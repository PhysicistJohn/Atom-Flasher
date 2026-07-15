// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OEM_ZS407_FIRMWARE_RELEASE,
  initialFirmwareUpdateState,
  type DeviceSnapshot,
  type FirmwareUpdateState,
  type PortCandidate,
} from '../src/core/contracts.js';
import {
  applicationSnapshotSchema,
  deriveAllowedActions,
  type ApplicationActionResult,
  type ApplicationSnapshot,
} from '../src/application/application-contract.js';
import { IPC_CAPABILITIES, type TinySaFlasherApi } from '../src/main/ipc-contract.js';
import { useFlasherApplication } from '../src/renderer/use-flasher-application.js';

const exactPort: PortCandidate = {
  id: '/dev/tty.fixture:CDC407:0483:5740',
  path: '/dev/tty.fixture',
  serialNumber: 'CDC407',
  vendorId: '0483',
  productId: '5740',
  usbMatch: 'exact-zs407-cdc',
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'tinySaFlasher');
});

describe('renderer flasher application controller', () => {
  it('ignores stale same-instance action and refresh snapshots but accepts a restarted instance', async () => {
    const initial = snapshot(10);
    const refreshAfterAction = snapshot(11);
    const staleRefresh = snapshot(9);
    const restarted = snapshot(1, '44444444-4444-4444-8444-444444444444');
    const snapshotCall = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(refreshAfterAction)
      .mockResolvedValueOnce(staleRefresh)
      .mockResolvedValueOnce(restarted);
    installApi(snapshotCall);
    const controller = renderHook(() => useFlasherApplication());
    await waitFor(() => expect(controller.result.current.snapshot?.sequence).toBe(10));

    const operation = vi.fn(async (): Promise<ApplicationActionResult> => ({ outcome: 'completed', snapshot: snapshot(12) }));
    await act(async () => { await controller.result.current.run('test operation', operation); });
    expect(operation).toHaveBeenCalledOnce();
    expect(controller.result.current.snapshot?.sequence).toBe(12);

    await act(async () => { await controller.result.current.refresh(); });
    expect(controller.result.current.snapshot?.sequence).toBe(12);

    await act(async () => { await controller.result.current.refresh(); });
    expect(controller.result.current.snapshot).toMatchObject({ instanceId: restarted.instanceId, sequence: 1 });
  });

  it('runs capabilities, initial snapshot, and one eligible startup scan in order', async () => {
    const initial = snapshot(1, undefined, { device: { connection: 'disconnected' }, update: initialFirmwareUpdateState() });
    const scanned = snapshot(2, undefined, {
      device: { connection: 'disconnected' },
      update: initialFirmwareUpdateState(),
      candidates: [exactPort],
    });
    const capabilities = vi.fn(async () => IPC_CAPABILITIES);
    const snapshotCall = vi.fn(async () => initial);
    const scanDevices = vi.fn(async (): Promise<ApplicationActionResult> => ({ outcome: 'completed', snapshot: scanned }));
    installApi(snapshotCall, { capabilities, scanDevices });

    const controller = renderHook(() => useFlasherApplication());
    await waitFor(() => expect(controller.result.current.snapshot?.sequence).toBe(2));
    expect(capabilities).toHaveBeenCalledOnce();
    expect(snapshotCall).toHaveBeenCalledOnce();
    expect(scanDevices).toHaveBeenCalledOnce();
    expect(capabilities.mock.invocationCallOrder[0]).toBeLessThan(snapshotCall.mock.invocationCallOrder[0]!);
    expect(snapshotCall.mock.invocationCallOrder[0]).toBeLessThan(scanDevices.mock.invocationCallOrder[0]!);
  });

  it('never overlaps poll requests and schedules the next poll only after settlement', async () => {
    vi.useFakeTimers();
    const pendingPoll = deferred<ApplicationSnapshot>();
    const snapshotCall = vi.fn()
      .mockResolvedValueOnce(snapshot(1))
      .mockImplementationOnce(() => pendingPoll.promise)
      .mockResolvedValue(snapshot(3));
    installApi(snapshotCall);
    const controller = renderHook(() => useFlasherApplication());
    await act(async () => { await flushPromises(); });
    expect(snapshotCall).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    expect(snapshotCall).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(snapshotCall).toHaveBeenCalledTimes(2);

    await act(async () => {
      pendingPoll.resolve(snapshot(2));
      await flushPromises();
    });
    expect(controller.result.current.snapshot?.sequence).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(749); });
    expect(snapshotCall).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(snapshotCall).toHaveBeenCalledTimes(3);
    controller.unmount();
  });

  it('admits only one renderer action before React can commit the busy state', async () => {
    const snapshotCall = vi.fn(async () => snapshot(1));
    installApi(snapshotCall);
    const controller = renderHook(() => useFlasherApplication());
    await waitFor(() => expect(controller.result.current.snapshot?.sequence).toBe(1));
    const pending = deferred<ApplicationActionResult>();
    const operation = vi.fn(() => pending.promise);

    let first!: Promise<void>;
    let duplicate!: Promise<void>;
    act(() => {
      first = controller.result.current.run('firmware action', operation);
      duplicate = controller.result.current.run('duplicate action', operation);
    });
    expect(operation).toHaveBeenCalledOnce();
    expect(controller.result.current.busy).toBe('firmware action');

    await act(async () => {
      pending.resolve({ outcome: 'completed', snapshot: snapshot(2) });
      await Promise.all([first, duplicate]);
    });
    expect(controller.result.current.busy).toBeUndefined();
    expect(controller.result.current.snapshot?.sequence).toBe(2);
  });
});

function installApi(
  snapshotCall: ReturnType<typeof vi.fn<() => Promise<ApplicationSnapshot>>>,
  overrides: Partial<TinySaFlasherApi> = {},
): TinySaFlasherApi {
  const completed = async (): Promise<ApplicationActionResult> => ({ outcome: 'completed', snapshot: await snapshotCall() });
  const api: TinySaFlasherApi = {
    capabilities: vi.fn(async () => IPC_CAPABILITIES),
    snapshot: snapshotCall,
    scanDevices: vi.fn(completed),
    connectDevice: vi.fn(completed),
    disconnectDevice: vi.fn(completed),
    recoverDevice: vi.fn(completed),
    selectOemTarget: vi.fn(completed),
    selectLocalFirmwareTarget: vi.fn(completed),
    download: vi.fn(completed),
    prepare: vi.fn(completed),
    detectDfu: vi.fn(completed),
    refreshPrerequisites: vi.fn(completed),
    flash: vi.fn(completed),
    ...overrides,
  };
  Object.defineProperty(window, 'tinySaFlasher', { configurable: true, value: api });
  return api;
}

function snapshot(
  sequence: number,
  instanceId = '33333333-3333-4333-8333-333333333333',
  overrides: {
    device?: DeviceSnapshot;
    update?: FirmwareUpdateState;
    candidates?: readonly PortCandidate[];
  } = {},
): ApplicationSnapshot {
  const device = overrides.device ?? readyDevice();
  const update = overrides.update ?? currentUpdate();
  const activity = { criticalSection: 'none' as const, admission: 'accepting' as const };
  const candidates = overrides.candidates ?? [];
  return applicationSnapshotSchema.parse({
    schemaVersion: 2,
    instanceId,
    sequence,
    capturedAt: '2026-07-14T16:00:00.000Z',
    activity,
    discovery: {
      candidates,
      ...(candidates.length ? { scannedAt: '2026-07-14T16:00:00.000Z' } : {}),
    },
    device,
    update,
    allowedActions: deriveAllowedActions(device, update, activity),
  });
}

function readyDevice(): DeviceSnapshot {
  return {
    connection: 'ready',
    connectedAt: '2026-07-14T15:59:00.000Z',
    telemetry: { batteryMillivolts: 4_200, deviceId: 407, capturedAt: '2026-07-14T16:00:00.000Z' },
    identity: {
      model: 'tinySA Ultra+ ZS407',
      hardwareVersion: 'V0.5.4 + ZS407',
      firmwareVersion: OEM_ZS407_FIRMWARE_RELEASE.version,
      firmwareReportedRevision: OEM_ZS407_FIRMWARE_RELEASE.revision,
      firmwareSourceCommit: OEM_ZS407_FIRMWARE_RELEASE.sourceCommit,
      firmwareQualification: 'supported-oem',
      port: exactPort,
      usbIdentityVerified: true,
    },
  };
}

function currentUpdate(): FirmwareUpdateState {
  return {
    ...initialFirmwareUpdateState(),
    phase: 'up-to-date',
    targetRelation: 'same',
    current: {
      version: OEM_ZS407_FIRMWARE_RELEASE.version,
      revision: OEM_ZS407_FIRMWARE_RELEASE.revision,
      sourceCommit: OEM_ZS407_FIRMWARE_RELEASE.sourceCommit,
      qualification: 'supported-oem',
    },
  };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve();
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
