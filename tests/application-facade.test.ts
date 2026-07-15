import { describe, expect, it, vi } from 'vitest';
import {
  OEM_ZS407_FIRMWARE_RELEASE,
  OEM_ZS407_SELF_TEST_PROCEDURE,
  ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT,
  ZS407_SHIPPED_FIRMWARE_VERSION,
  canonicalDfuFingerprint,
  initialFirmwareUpdateState,
  type DeviceSnapshot,
  type FirmwareUpdateState,
  type PortCandidate,
} from '../src/core/contracts.js';
import {
  FlasherApplication,
  type ApplicationDevicePort,
  type ApplicationUpdaterPort,
  type LocalFirmwareTargetSelection,
  type LocalFirmwareTargetPickerPort,
  type NativeSafetyPromptPort,
} from '../src/application/flasher-application.js';

const now = '2026-07-14T18:00:00.000Z';
const instanceId = '44444444-4444-4444-8444-444444444444';
const preparationId = '11111111-1111-4111-8111-111111111111';
const candidate: PortCandidate = {
  id: 'exact-zs407',
  path: '/dev/tty.exact-zs407',
  vendorId: '0483',
  productId: '5740',
  serialNumber: 'CDC-ZS407',
  usbMatch: 'exact-zs407-cdc',
};
const disconnected: DeviceSnapshot = { connection: 'disconnected' };
const connected: DeviceSnapshot = {
  connection: 'ready',
  connectedAt: now,
  telemetry: { batteryMillivolts: 4_211, deviceId: 407, capturedAt: now },
  identity: {
    model: 'tinySA Ultra+ ZS407',
    hardwareVersion: 'V0.5.4 + ZS407',
    firmwareVersion: ZS407_SHIPPED_FIRMWARE_VERSION,
    firmwareReportedRevision: 'c5dd31f',
    firmwareSourceCommit: ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT,
    firmwareQualification: 'supported-oem',
    port: candidate,
    usbIdentityVerified: true,
  },
};
const current = {
  version: ZS407_SHIPPED_FIRMWARE_VERSION,
  revision: 'c5dd31f' as const,
  sourceCommit: ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT,
  qualification: 'supported-oem' as const,
};
const artifact = {
  sizeBytes: OEM_ZS407_FIRMWARE_RELEASE.sizeBytes,
  sha256: OEM_ZS407_FIRMWARE_RELEASE.sha256,
  verifiedAt: now,
};
const preparation = {
  id: preparationId,
  preparedAt: now,
  batteryMillivolts: 4_211,
  deviceId: 407,
  screenSha256: 'a'.repeat(64),
  selfTestPassed: true as const,
  selfTestProcedure: OEM_ZS407_SELF_TEST_PROCEDURE.id,
  configurationDisposition: 'new-device-unchanged' as const,
  rfPortsDisconnected: true as const,
  onlyUsbDeviceConnected: true as const,
  usbContinuity: {
    cdcPath: candidate.path,
    cdcSerialNumber: candidate.serialNumber,
    vendorId: '0483' as const,
    productId: '5740' as const,
    deviceId: 407,
  },
};
const dfuName = '@Internal Flash /0x08000000/01*016Kg,03*016Kg,01*064Kg,07*128Kg';
const dfuBase = { path: '1-2', devnum: '3', serial: 'DFU-ZS407', alt: 0 as const, name: dfuName };
const dfuIdentity = {
  ...dfuBase,
  fingerprint: canonicalDfuFingerprint(dfuBase),
  targetLine: `Found DFU: [0483:df11] devnum=3, path="1-2", alt=0, name="${dfuName}", serial="DFU-ZS407"`,
};

function availableState(): FirmwareUpdateState {
  return {
    ...initialFirmwareUpdateState(),
    phase: 'available',
    current,
    targetRelation: 'different-supported',
    writeIntent: 'update-oem',
    updateAvailable: true,
  };
}

function verifiedState(): FirmwareUpdateState {
  return { ...availableState(), phase: 'verified', artifact };
}

function readyState(): FirmwareUpdateState {
  return {
    ...verifiedState(),
    phase: 'ready-to-flash',
    preparation,
    dfuUtility: { available: true, version: '0.11' },
    dfuDevice: { detected: true, count: 1, identity: dfuIdentity },
  };
}

function customReadyState(): FirmwareUpdateState {
  const sha256 = 'b'.repeat(64);
  const target = {
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
  return {
    ...initialFirmwareUpdateState(target),
    phase: 'ready-to-flash',
    current,
    targetRelation: 'different-supported',
    writeIntent: 'install-custom',
    updateAvailable: true,
    artifact: { targetId: target.targetId, sizeBytes: target.sizeBytes, sha256, verifiedAt: now },
    preparation,
    dfuUtility: { available: true, version: '0.11' },
    dfuDevice: { detected: true, count: 1, identity: dfuIdentity },
  };
}

function harness(
  initialDevice: DeviceSnapshot,
  initialUpdate: FirmwareUpdateState,
  targetPicker?: LocalFirmwareTargetPickerPort,
) {
  let deviceState = initialDevice;
  let updateState = initialUpdate;
  const device: ApplicationDevicePort = {
    listDevices: vi.fn(async () => [candidate]),
    snapshot: vi.fn(() => deviceState),
    connect: vi.fn(async () => { deviceState = connected; return deviceState; }),
    disconnect: vi.fn(async () => { deviceState = disconnected; }),
    recoverAfterManualPowerOff: vi.fn(async () => { deviceState = disconnected; return deviceState; }),
  };
  const updater: ApplicationUpdaterPort = {
    state: vi.fn(async () => updateState),
    snapshot: vi.fn(() => updateState),
    download: vi.fn(async () => updateState),
    prepare: vi.fn(async () => updateState),
    detectDfu: vi.fn(async () => updateState),
    refreshPrerequisites: vi.fn(async () => updateState),
    flash: vi.fn(async () => updateState),
    selectOemTarget: vi.fn(async () => updateState),
    admitLocalCustomTarget: vi.fn(async () => updateState),
  };
  const prompts: NativeSafetyPromptPort = {
    confirmFirmwareWrite: vi.fn(async () => false),
    confirmPhysicalPowerOff: vi.fn(async () => false),
  };
  const application = new FlasherApplication(device, updater, prompts, targetPicker, {
    now: () => new Date(now),
    randomUuid: () => instanceId,
  });
  return {
    application,
    device,
    updater,
    prompts,
    targetPicker,
    setDevice(value: DeviceSnapshot) { deviceState = value; },
    setUpdate(value: FirmwareUpdateState) { updateState = value; },
  };
}

describe('application facade safety policy', () => {
  it('coalesces concurrent initialization at the updater recovery boundary', async () => {
    const subject = harness(disconnected, initialFirmwareUpdateState());
    let finishInitialization!: () => void;
    vi.mocked(subject.updater.state).mockImplementationOnce(() => new Promise((resolve) => {
      finishInitialization = () => resolve(initialFirmwareUpdateState());
    }));
    const first = subject.application.initialize();
    const second = subject.application.initialize();
    expect(subject.updater.state).toHaveBeenCalledTimes(1);
    finishInitialization();
    const [one, two] = await Promise.all([first, second]);
    expect(one.instanceId).toBe(two.instanceId);
    expect(two.sequence).toBeGreaterThan(one.sequence);
  });

  it('publishes deterministic, schema-derived discovery snapshots and enforces advertised actions', async () => {
    const subject = harness(disconnected, initialFirmwareUpdateState());
    const initialized = await subject.application.initialize();
    expect(initialized).toMatchObject({ instanceId, sequence: 1, capturedAt: now });

    const scanned = await subject.application.scanDevices();
    expect(scanned.snapshot.discovery).toEqual({ candidates: [candidate], scannedAt: now });
    await expect(subject.application.download()).rejects.toThrow(/policy does not allow download-firmware/i);
    expect(subject.updater.download).not.toHaveBeenCalled();
  });

  it('keeps the firmware boundary closed when the native write prompt is cancelled', async () => {
    const subject = harness(disconnected, readyState());
    await subject.application.initialize();
    let answer!: (confirmed: boolean) => void;
    vi.mocked(subject.prompts.confirmFirmwareWrite).mockImplementation(() => new Promise((resolve) => { answer = resolve; }));

    const pending = subject.application.flash(preparationId);
    expect(subject.application.criticalSection).toBe('native-confirmation');
    await expect(subject.application.requestShutdown()).resolves.toBe('blocked-critical');
    expect(subject.application.admission).toBe('accepting');
    answer(false);

    await expect(pending).resolves.toMatchObject({ outcome: 'cancelled' });
    expect(subject.updater.flash).not.toHaveBeenCalled();
    expect(subject.application.criticalSection).toBe('none');
  });

  it('keeps native custom-target selection pathless, cancellable, and shutdown-critical', async () => {
    const target = customReadyState().target;
    if (target.kind !== 'local-custom') throw new Error('Fixture target must be custom');
    const admittedArtifact = {
      targetId: target.targetId,
      openVerified: vi.fn(async () => ({
        descriptor: 41,
        bytes: new Uint8Array(target.sizeBytes),
        assertStable: async () => undefined,
        close: async () => undefined,
      })),
    };
    let answer!: (value: LocalFirmwareTargetSelection | undefined) => void;
    const picker: LocalFirmwareTargetPickerPort = {
      selectLocalFirmwareTarget: vi.fn(() => new Promise<LocalFirmwareTargetSelection | undefined>((resolve) => { answer = resolve; })),
    };
    const subject = harness(connected, availableState(), picker);
    await subject.application.initialize();

    const pending = subject.application.selectLocalFirmwareTarget();
    expect(subject.application.criticalSection).toBe('native-file-selection');
    await expect(subject.application.requestShutdown()).resolves.toBe('blocked-critical');
    answer({ target, artifact: admittedArtifact });

    await expect(pending).resolves.toMatchObject({ outcome: 'completed' });
    expect(subject.updater.admitLocalCustomTarget).toHaveBeenCalledWith(target, admittedArtifact);
    expect(subject.application.criticalSection).toBe('none');
  });

  it('does not mutate updater state when native custom-target selection is cancelled', async () => {
    const picker: LocalFirmwareTargetPickerPort = {
      selectLocalFirmwareTarget: vi.fn(async () => undefined),
    };
    const subject = harness(connected, availableState(), picker);
    await subject.application.initialize();
    await expect(subject.application.selectLocalFirmwareTarget()).resolves.toMatchObject({ outcome: 'cancelled' });
    expect(subject.updater.admitLocalCustomTarget).not.toHaveBeenCalled();
  });

  it('rejects a different custom target at the facade when a preparation already exists', async () => {
    const prepared = customReadyState();
    if (prepared.target.kind !== 'local-custom') throw new Error('Fixture target must be custom');
    const differentTarget = { ...prepared.target, manifestSha256: 'e'.repeat(64) };
    const admittedArtifact = {
      targetId: differentTarget.targetId,
      openVerified: vi.fn(async () => ({
        descriptor: 42,
        bytes: new Uint8Array(differentTarget.sizeBytes),
        assertStable: async () => undefined,
        close: async () => undefined,
      })),
    };
    const picker: LocalFirmwareTargetPickerPort = {
      selectLocalFirmwareTarget: vi.fn(async () => ({ target: differentTarget, artifact: admittedArtifact })),
    };
    const subject = harness(disconnected, prepared, picker);
    await subject.application.initialize();

    await expect(subject.application.selectLocalFirmwareTarget()).rejects.toThrow(/exact selected custom target/i);
    expect(subject.updater.admitLocalCustomTarget).not.toHaveBeenCalled();
    expect(subject.application.criticalSection).toBe('none');
  });

  it('holds the critical section from native confirmation through updater verification', async () => {
    const subject = harness(disconnected, readyState());
    await subject.application.initialize();
    vi.mocked(subject.prompts.confirmFirmwareWrite).mockResolvedValue(true);
    let finishWrite!: () => void;
    vi.mocked(subject.updater.flash).mockImplementation((request) => {
      expect(request).toEqual({ preparationId, confirmation: 'FLASH VERIFIED OEM FIRMWARE' });
      return new Promise((resolve) => { finishWrite = () => resolve(readyState()); });
    });

    const pending = subject.application.flash(preparationId);
    await vi.waitFor(() => expect(subject.application.criticalSection).toBe('firmware-write-or-verification'));
    await expect(subject.application.releaseForWindowClose()).resolves.toBe('blocked-critical');
    finishWrite();

    await expect(pending).resolves.toMatchObject({ outcome: 'completed' });
    expect(subject.application.criticalSection).toBe('none');
  });

  it('binds local custom confirmation to the selected target kind and digest', async () => {
    const state = customReadyState();
    if (state.target.kind !== 'local-custom') throw new Error('Fixture target must be custom');
    const subject = harness(disconnected, state);
    await subject.application.initialize();
    vi.mocked(subject.prompts.confirmFirmwareWrite).mockResolvedValue(true);
    vi.mocked(subject.updater.flash).mockResolvedValue(state);

    await expect(subject.application.flash(preparationId)).resolves.toMatchObject({ outcome: 'completed' });
    expect(subject.prompts.confirmFirmwareWrite).toHaveBeenCalledWith({
      preparationId,
      targetId: state.target.targetId,
      targetKind: 'local-custom',
      targetVersion: state.target.version,
      targetSha256: state.target.sha256,
      targetManifestSha256: state.target.manifestSha256,
    });
    expect(subject.updater.flash).toHaveBeenCalledWith({
      preparationId,
      confirmation: 'FLASH VERIFIED CUSTOM FIRMWARE',
    });
  });

  it('drains an ordinary operation before safe disconnect and closes admission permanently', async () => {
    const subject = harness(connected, availableState());
    await subject.application.initialize();
    let finishDownload!: () => void;
    vi.mocked(subject.updater.download).mockImplementation(() => new Promise((resolve) => {
      finishDownload = () => { subject.setUpdate(verifiedState()); resolve(verifiedState()); };
    }));

    const download = subject.application.download();
    const shutdown = subject.application.requestShutdown();
    expect(subject.application.admission).toBe('draining');
    expect(subject.device.disconnect).not.toHaveBeenCalled();
    await expect(subject.application.scanDevices()).rejects.toThrow(/admission is draining/i);
    finishDownload();

    await expect(download).resolves.toMatchObject({ outcome: 'completed' });
    await expect(shutdown).resolves.toBe('safe');
    expect(subject.device.disconnect).toHaveBeenCalledTimes(1);
    expect(subject.application.admission).toBe('closed');
    await expect(subject.application.download()).rejects.toThrow(/admission is closed/i);
  });

  it('serializes overlapping close and quit releases without reopening closed admission', async () => {
    const subject = harness(connected, availableState());
    await subject.application.initialize();
    let finishDownload!: () => void;
    vi.mocked(subject.updater.download).mockImplementation(() => new Promise((resolve) => {
      finishDownload = () => { subject.setUpdate(verifiedState()); resolve(verifiedState()); };
    }));

    const download = subject.application.download();
    const close = subject.application.releaseForWindowClose();
    const quit = subject.application.requestShutdown();
    finishDownload();

    await expect(download).resolves.toMatchObject({ outcome: 'completed' });
    await expect(close).resolves.toBe('safe');
    await expect(quit).resolves.toBe('safe');
    expect(subject.device.disconnect).toHaveBeenCalledTimes(1);
    expect(subject.application.admission).toBe('closed');
    await expect(subject.application.releaseForWindowClose()).resolves.toBe('safe');
    expect(subject.application.admission).toBe('closed');
    expect(() => subject.application.resumeAfterWindowOpen()).toThrow(/permanently closed/i);
  });

  it('requires the physical-power-off native confirmation before fault recovery', async () => {
    const faulted: DeviceSnapshot = { connection: 'faulted', fault: 'RF output-off acknowledgement was lost' };
    const subject = harness(faulted, initialFirmwareUpdateState());
    await subject.application.initialize();
    await expect(subject.application.recoverDevice()).resolves.toMatchObject({ outcome: 'cancelled' });
    expect(subject.device.recoverAfterManualPowerOff).not.toHaveBeenCalled();

    vi.mocked(subject.prompts.confirmPhysicalPowerOff).mockResolvedValue(true);
    const recovered = await subject.application.recoverDevice();
    expect(recovered).toMatchObject({ outcome: 'completed', snapshot: { device: { connection: 'disconnected' } } });
    expect(subject.device.recoverAfterManualPowerOff).toHaveBeenCalledWith('DEVICE IS PHYSICALLY POWERED OFF');
  });
});
