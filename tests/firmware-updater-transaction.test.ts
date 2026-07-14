import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OEM_ZS407_FIRMWARE_RELEASE,
  OEM_ZS407_SELF_TEST_PROCEDURE,
  ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT,
  type DeviceDiagnostics,
  type DeviceSnapshot,
  type PortCandidate,
  type ScreenFrame,
} from '../src/core/contracts.js';
import {
  FirmwareUpdater,
  type DfuExecutionResult,
  type FirmwareUpdateDevice,
  type FirmwareUpdaterRuntime,
} from '../src/core/firmware-updater.js';
import { inspectFirmwareSafetyEvidence } from '../src/core/legacy-migration.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

const cdcCandidate: PortCandidate = {
  id: '/dev/tty.CDC407:CDC407:0483:5740', path: '/dev/tty.CDC407', vendorId: '0483', productId: '5740', serialNumber: 'CDC407', usbMatch: 'exact-zs407-cdc',
};
const dfuLine = 'Found DFU: [0483:df11] ver=2200, devnum=5, cfg=1, intf=0, path="1-1", alt=0, name="@Internal Flash  /0x08000000/128*002Kg", serial="DFU407"';

describe('FirmwareUpdater transaction boundaries', () => {
  it('persists lock and started journal before exact selected dfu-util argv, then archives only after reboot proof', async () => {
    let directory = '';
    let observedArgs: readonly string[] = [];
    let journalBeforeSpawn: unknown;
    let lockBeforeSpawn = false;
    const device = new FakeFirmwareDevice();
    const fixture = await readyFixture(device, async (_file, args, _duration, onProgress) => {
      observedArgs = args;
      journalBeforeSpawn = JSON.parse(await readFile(join(directory, 'firmware-update-journal-v1.json'), 'utf8'));
      lockBeforeSpawn = await present(join(directory, 'firmware-write.lock'));
      onProgress({ operation: 'erase', percent: 100 });
      onProgress({ operation: 'download', percent: 100 });
      return successfulTransfer();
    });
    directory = fixture.directory;

    const completed = await fixture.updater.flash({ preparationId: fixture.preparationId, confirmation: 'FLASH VERIFIED OEM FIRMWARE' });

    expect(lockBeforeSpawn).toBe(true);
    expect(journalBeforeSpawn).toMatchObject({ state: { phase: 'flashing', writeDisposition: 'started', writeStartedAt: expect.any(String) } });
    expect(observedArgs.slice(0, 12)).toEqual([
      '-d', '0483:df11', '-p', '1-1', '-S', 'DFU407', '-a', '0', '-s', '0x08000000:leave', '-D', expect.any(String),
    ]);
    expect(basename(observedArgs[11]!)).toBe(`${OEM_ZS407_FIRMWARE_RELEASE.version}.bin`);
    expect(completed).toMatchObject({ phase: 'completed', writeDisposition: 'completed', current: { revision: 'c979386' } });
    expect(await present(join(directory, 'firmware-write.lock'))).toBe(false);
    expect(await present(join(directory, 'firmware-update-journal-v1.json'))).toBe(false);
    const ledger = await readdir(join(directory, 'completed-ledger-v1'));
    expect(ledger).toEqual([`device-407-preparation-${fixture.preparationId}.json`]);
    expect(JSON.parse(await readFile(join(directory, 'completed-ledger-v1', ledger[0]!), 'utf8'))).toMatchObject({ state: { phase: 'completed', completedAt: expect.any(String) } });
    expect(await inspectFirmwareSafetyEvidence(directory)).toEqual([]);
  });

  it('retains a globally blocking started journal and lock when dfu-util fails after spawn', async () => {
    const device = new FakeFirmwareDevice();
    const fixture = await readyFixture(device, async () => { throw new Error('dfu-util exited with code 74: transfer failed'); });

    await expect(fixture.updater.flash({ preparationId: fixture.preparationId, confirmation: 'FLASH VERIFIED OEM FIRMWARE' })).rejects.toThrow(/do not flash again.*code 74/i);
    expect(fixture.updater.snapshot()).toMatchObject({ phase: 'failed', writeDisposition: 'started' });
    expect(await present(join(fixture.directory, 'firmware-write.lock'))).toBe(true);
    expect(JSON.parse(await readFile(join(fixture.directory, 'firmware-update-journal-v1.json'), 'utf8'))).toMatchObject({ state: { phase: 'failed', writeDisposition: 'started' } });

    const recovered = new FirmwareUpdater(fixture.directory, new FakeFirmwareDevice({ disconnected: true }), fixture.runtime);
    expect(await recovered.state()).toMatchObject({ phase: 'failed', writeDisposition: 'started' });
    await expect(recovered.detectDfu()).rejects.toThrow(/write attempt already began/i);
  });

  it('does not treat exit zero without dfu-util download confirmation as a completed write', async () => {
    const fixture = await readyFixture(new FakeFirmwareDevice(), async () => ({
      stdout: 'dfu-util returned zero without a completion line', stderr: '', outputTruncated: false, exceededExpectedDuration: false,
    }));
    await expect(fixture.updater.flash({ preparationId: fixture.preparationId, confirmation: 'FLASH VERIFIED OEM FIRMWARE' })).rejects.toThrow(/without its successful-download confirmation/i);
    expect(fixture.updater.snapshot()).toMatchObject({ phase: 'failed', writeDisposition: 'started' });
    expect(await present(join(fixture.directory, 'firmware-write.lock'))).toBe(true);
  });

  it('treats successful bytes followed by the wrong reboot device ID as completed-but-unverified', async () => {
    const device = new FakeFirmwareDevice({ postFlashDeviceId: 999 });
    const fixture = await readyFixture(device, async () => successfulTransfer());

    await expect(fixture.updater.flash({ preparationId: fixture.preparationId, confirmation: 'FLASH VERIFIED OEM FIRMWARE' })).rejects.toThrow(/write completed but post-flash verification failed.*does not match preflight ID/i);
    expect(fixture.updater.snapshot()).toMatchObject({ phase: 'failed', writeDisposition: 'completed' });
    expect(await present(join(fixture.directory, 'firmware-write.lock'))).toBe(true);
    expect(await present(join(fixture.directory, 'firmware-update-journal-v1.json'))).toBe(true);
    expect(await present(join(fixture.directory, 'completed-ledger-v1'))).toBe(false);
  });

  it.each([
    'tinySA4_custom-gc979386',
    'tinySA4_v1.4-224-gc979386-dirty',
  ])('rejects post-flash version spoof %s even when the identity claims the target commit', async (postFlashFirmwareVersion) => {
    const device = new FakeFirmwareDevice({ postFlashFirmwareVersion });
    const fixture = await readyFixture(device, async () => successfulTransfer());

    await expect(fixture.updater.flash({ preparationId: fixture.preparationId, confirmation: 'FLASH VERIFIED OEM FIRMWARE' }))
      .rejects.toThrow(/write completed but post-flash verification failed.*post-flash identity is/i);
    expect(fixture.updater.snapshot()).toMatchObject({ phase: 'failed', writeDisposition: 'completed' });
    expect(await present(join(fixture.directory, 'firmware-write.lock'))).toBe(true);
    expect(await present(join(fixture.directory, 'completed-ledger-v1'))).toBe(false);
  });

  it('turns a crash-created orphan write lock into indeterminate state without invoking tooling', async () => {
    const directory = await temporary();
    await import('node:fs/promises').then(({ mkdir, writeFile }) => mkdir(directory, { recursive: true }).then(() => writeFile(join(directory, 'firmware-write.lock'), '{"ambiguous":true}')));
    const runtime = runtimeFixture(async () => { throw new Error('must not spawn'); });
    const updater = new FirmwareUpdater(directory, new FakeFirmwareDevice({ disconnected: true }), runtime);
    expect(await updater.state()).toMatchObject({ phase: 'failed', writeDisposition: 'indeterminate', error: expect.stringMatching(/orphaned|write lock/i) });
  });

  it('makes a stale mutator indeterminate without changing a winner journal while the write lock is held', async () => {
    let releaseWinner!: () => void;
    let winnerSpawned!: () => void;
    const spawned = new Promise<void>((resolve) => { winnerSpawned = resolve; });
    let spawnCount = 0;
    const runDfu: FirmwareUpdaterRuntime['runDfuExecutable'] = async () => {
      spawnCount += 1;
      winnerSpawned();
      await new Promise<void>((resolve) => { releaseWinner = resolve; });
      return successfulTransfer();
    };
    const fixture = await readyFixture(new FakeFirmwareDevice(), runDfu);
    const stale = fixture.updater;
    const winner = await loadReadyPeer(fixture.directory, fixture.runtime);

    const winningFlash = winner.flash({ preparationId: fixture.preparationId, confirmation: 'FLASH VERIFIED OEM FIRMWARE' });
    await spawned;
    const winningJournal = await readFile(join(fixture.directory, 'firmware-update-journal-v1.json'), 'utf8');
    await expect(stale.detectDfu()).rejects.toThrow(/shared firmware safety evidence|shared firmware write boundary/i);
    expect(await readFile(join(fixture.directory, 'firmware-update-journal-v1.json'), 'utf8')).toBe(winningJournal);
    expect(stale.snapshot()).toMatchObject({ phase: 'failed', writeDisposition: 'indeterminate' });
    await expect(stale.detectDfu()).rejects.toThrow(/indeterminate/i);

    releaseWinner();
    await expect(winningFlash).resolves.toMatchObject({ phase: 'completed' });
    expect(spawnCount).toBe(1);
  });

  it('rejects a stale flasher that paused before lock acquisition after the winner archived, without touching winner evidence', async () => {
    let releaseStale!: () => void;
    let stalePaused!: () => void;
    const paused = new Promise<void>((resolve) => { stalePaused = resolve; });
    const resume = new Promise<void>((resolve) => { releaseStale = resolve; });
    let spawnCount = 0;
    const winnerRun: FirmwareUpdaterRuntime['runDfuExecutable'] = async () => { spawnCount += 1; return successfulTransfer(); };
    const fixture = await readyFixture(new FakeFirmwareDevice(), winnerRun);
    const staleRuntime: Partial<FirmwareUpdaterRuntime> = {
      ...fixture.runtime,
      beforeWriteLockAcquire: async () => { stalePaused(); await resume; },
      runDfuExecutable: async () => { spawnCount += 1; return successfulTransfer(); },
    };
    const stale = await loadReadyPeer(fixture.directory, staleRuntime);
    const winner = await loadReadyPeer(fixture.directory, fixture.runtime);

    const staleFlash = stale.flash({ preparationId: fixture.preparationId, confirmation: 'FLASH VERIFIED OEM FIRMWARE' });
    await paused;
    await expect(winner.flash({ preparationId: fixture.preparationId, confirmation: 'FLASH VERIFIED OEM FIRMWARE' })).resolves.toMatchObject({ phase: 'completed' });
    const flatLedgerPath = join(fixture.directory, 'completed-ledger-v1', `device-407-preparation-${fixture.preparationId}.json`);
    const nestedLedgerDirectory = join(fixture.directory, 'completed-ledger-v1', 'archive', '2026');
    await mkdir(nestedLedgerDirectory, { recursive: true });
    const ledgerPath = join(nestedLedgerDirectory, `device-407-preparation-${fixture.preparationId}.json`);
    await rename(flatLedgerPath, ledgerPath);
    const winningLedger = await readFile(ledgerPath, 'utf8');

    releaseStale();
    await expect(staleFlash).rejects.toThrow(/permanently blocked.*did not modify the shared journal/i);
    expect(stale.snapshot()).toMatchObject({ phase: 'failed', writeDisposition: 'indeterminate' });
    expect(await present(join(fixture.directory, 'firmware-write.lock'))).toBe(false);
    expect(await present(join(fixture.directory, 'firmware-update-journal-v1.json'))).toBe(false);
    expect(await readFile(ledgerPath, 'utf8')).toBe(winningLedger);
    expect(spawnCount).toBe(1);
  });

  it('rejects a resurrected ready journal when the same preparation already has an immutable ledger', async () => {
    let spawnCount = 0;
    const fixture = await readyFixture(new FakeFirmwareDevice(), async () => { spawnCount += 1; return successfulTransfer(); });
    const readyJournal = await readFile(join(fixture.directory, 'firmware-update-journal-v1.json'));
    await expect(fixture.updater.flash({ preparationId: fixture.preparationId, confirmation: 'FLASH VERIFIED OEM FIRMWARE' })).resolves.toMatchObject({ phase: 'completed' });
    const flatLedgerPath = join(fixture.directory, 'completed-ledger-v1', `device-407-preparation-${fixture.preparationId}.json`);
    const nestedLedgerDirectory = join(fixture.directory, 'completed-ledger-v1', 'archive', '2026');
    await mkdir(nestedLedgerDirectory, { recursive: true });
    const ledgerPath = join(nestedLedgerDirectory, `device-407-preparation-${fixture.preparationId}.json`);
    await rename(flatLedgerPath, ledgerPath);
    const winningLedger = await readFile(ledgerPath, 'utf8');
    for (const name of await readdir(fixture.directory)) {
      if (name.startsWith(`result-${fixture.preparationId}-`)) await rm(join(fixture.directory, name));
    }
    await writeFile(join(fixture.directory, 'firmware-update-journal-v1.json'), readyJournal, { flag: 'wx' });

    const resurrected = new FirmwareUpdater(fixture.directory, new FakeFirmwareDevice({ disconnected: true }), fixture.runtime);
    expect(await resurrected.state()).toMatchObject({ phase: 'awaiting-dfu', writeDisposition: 'not-started' });
    expect(await resurrected.detectDfu()).toMatchObject({ phase: 'ready-to-flash' });
    const resurrectedJournal = await readFile(join(fixture.directory, 'firmware-update-journal-v1.json'), 'utf8');
    await expect(resurrected.flash({ preparationId: fixture.preparationId, confirmation: 'FLASH VERIFIED OEM FIRMWARE' })).rejects.toThrow(/completed ledger|permanently blocked/i);
    expect(await readFile(join(fixture.directory, 'firmware-update-journal-v1.json'), 'utf8')).toBe(resurrectedJournal);
    expect(await readFile(ledgerPath, 'utf8')).toBe(winningLedger);
    expect(await present(join(fixture.directory, 'firmware-write.lock'))).toBe(false);
    expect(resurrected.snapshot()).toMatchObject({ phase: 'failed', writeDisposition: 'indeterminate' });
    expect(spawnCount).toBe(1);
  });

  it('does not overwrite a ready journal when another owner wins the exclusive lock first', async () => {
    let spawned = false;
    const fixture = await readyFixture(new FakeFirmwareDevice(), async () => { spawned = true; return successfulTransfer(); });
    const journalBefore = await readFile(join(fixture.directory, 'firmware-update-journal-v1.json'), 'utf8');
    await writeFile(join(fixture.directory, 'firmware-write.lock'), '{"owner":"other-process"}', { flag: 'wx' });

    await expect(fixture.updater.flash({ preparationId: fixture.preparationId, confirmation: 'FLASH VERIFIED OEM FIRMWARE' })).rejects.toThrow(/permanently blocked.*did not modify the shared journal/i);
    expect(spawned).toBe(false);
    expect(await readFile(join(fixture.directory, 'firmware-update-journal-v1.json'), 'utf8')).toBe(journalBefore);
    expect(fixture.updater.snapshot()).toMatchObject({ phase: 'failed', writeDisposition: 'indeterminate' });
  });
});

async function readyFixture(
  device: FakeFirmwareDevice,
  runDfuExecutable: FirmwareUpdaterRuntime['runDfuExecutable'],
): Promise<{ directory: string; updater: FirmwareUpdater; runtime: Partial<FirmwareUpdaterRuntime>; preparationId: string }> {
  const directory = await temporary();
  const runtime = runtimeFixture(runDfuExecutable);
  const updater = new FirmwareUpdater(directory, device, runtime);
  expect(await updater.state()).toMatchObject({ phase: 'available', updateAvailable: true });
  expect(await updater.download()).toMatchObject({ phase: 'verified', artifact: { sizeBytes: OEM_ZS407_FIRMWARE_RELEASE.sizeBytes } });
  const prepared = await updater.prepare({
    selfTestPassed: true,
    selfTestProcedure: OEM_ZS407_SELF_TEST_PROCEDURE.id,
    configurationDisposition: 'new-device-unchanged',
    rfPortsDisconnected: true,
    onlyUsbDeviceConnected: true,
  });
  const preparationId = prepared.preparation!.id;
  expect(prepared.phase).toBe('awaiting-dfu');
  expect(await updater.detectDfu()).toMatchObject({ phase: 'ready-to-flash', dfuDevice: { identity: { path: '1-1', serial: 'DFU407' } } });
  return { directory, updater, runtime, preparationId };
}

async function loadReadyPeer(directory: string, runtime: Partial<FirmwareUpdaterRuntime>): Promise<FirmwareUpdater> {
  const peer = new FirmwareUpdater(directory, new FakeFirmwareDevice({ disconnected: true }), runtime);
  expect(await peer.state()).toMatchObject({ phase: 'awaiting-dfu', writeDisposition: 'not-started' });
  expect(await peer.detectDfu()).toMatchObject({ phase: 'ready-to-flash' });
  return peer;
}

function runtimeFixture(runDfuExecutable: FirmwareUpdaterRuntime['runDfuExecutable']): Partial<FirmwareUpdaterRuntime> {
  return {
    fetch: async () => new Response(new Uint8Array(OEM_ZS407_FIRMWARE_RELEASE.sizeBytes), { status: 200, headers: { 'content-length': String(OEM_ZS407_FIRMWARE_RELEASE.sizeBytes) } }),
    locateDfuUtility: async () => '/fixture/dfu-util',
    runExecutable: async (_file, args) => args.includes('--version') ? { stdout: 'dfu-util 0.11', stderr: '' } : { stdout: dfuLine, stderr: '' },
    runDfuExecutable,
    verifyArtifact: () => undefined,
    delay: async () => undefined,
  };
}

function successfulTransfer(): DfuExecutionResult {
  return { stdout: 'Download done.\nFile downloaded successfully', stderr: '', outputTruncated: false, exceededExpectedDuration: false };
}

class FakeFirmwareDevice implements FirmwareUpdateDevice {
  #snapshot: DeviceSnapshot;
  constructor(private readonly options: { disconnected?: boolean; postFlashDeviceId?: number; postFlashFirmwareVersion?: string } = {}) {
    this.#snapshot = options.disconnected ? { connection: 'disconnected' } : outdatedSnapshot();
  }
  snapshot(): DeviceSnapshot { return structuredClone(this.#snapshot); }
  async readDiagnostics(): Promise<DeviceDiagnostics> {
    const identity = outdatedSnapshot().identity!;
    return {
      identity,
      firmwareVersionResponse: identity.firmwareVersion,
      infoLines: ['tinySA ULTRA+ ZS407'],
      commands: ['version', 'info', 'help', 'mode', 'output', 'vbat', 'deviceid', 'capture'],
      telemetry: { batteryMillivolts: 4211, deviceId: 407, capturedAt: new Date().toISOString() },
      capturedAt: new Date().toISOString(),
    };
  }
  async captureScreen(): Promise<ScreenFrame> { return { width: 480, height: 320, format: 'rgb565le', pixels: Uint8Array.of(1, 2, 3, 4), capturedAt: new Date().toISOString() }; }
  async disconnect(): Promise<void> { this.#snapshot = { connection: 'disconnected' }; }
  async listDevices(): Promise<PortCandidate[]> { return [cdcCandidate]; }
  async connect(candidate: PortCandidate): Promise<DeviceSnapshot> {
    this.#snapshot = targetSnapshot(candidate, this.options.postFlashDeviceId ?? 407, this.options.postFlashFirmwareVersion);
    return this.snapshot();
  }
}

function outdatedSnapshot(): DeviceSnapshot {
  return {
    connection: 'ready',
    identity: {
      model: 'tinySA Ultra+ ZS407', hardwareVersion: 'V0.5.4 + ZS407', firmwareVersion: 'tinySA4_v1.4-217-gc5dd31f',
      firmwareReportedRevision: 'c5dd31f', firmwareSourceCommit: ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT, firmwareQualification: 'supported-oem',
      port: cdcCandidate, usbIdentityVerified: true,
    },
    telemetry: { batteryMillivolts: 4211, deviceId: 407, capturedAt: new Date().toISOString() },
  };
}

function targetSnapshot(candidate: PortCandidate, deviceId: number, firmwareVersion: string = OEM_ZS407_FIRMWARE_RELEASE.version): DeviceSnapshot {
  return {
    connection: 'ready',
    identity: {
      model: 'tinySA Ultra+ ZS407', hardwareVersion: 'V0.5.4 + ZS407', firmwareVersion,
      firmwareReportedRevision: OEM_ZS407_FIRMWARE_RELEASE.revision, firmwareSourceCommit: OEM_ZS407_FIRMWARE_RELEASE.sourceCommit, firmwareQualification: 'supported-oem',
      port: candidate, usbIdentityVerified: true,
    },
    telemetry: { batteryMillivolts: 4211, deviceId, capturedAt: new Date().toISOString() },
  };
}

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tinysa-flasher-transaction-'));
  directories.push(directory);
  return directory;
}

async function present(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
