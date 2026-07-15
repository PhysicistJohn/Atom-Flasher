import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OEM_ZS407_FIRMWARE_RELEASE,
  OEM_ZS407_FIRMWARE_TARGET,
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
  type FirmwareUpdaterTestHooks,
} from '../src/core/firmware-updater.js';
import { inspectFirmwareSafetyEvidence } from '../src/core/legacy-migration.js';
import { JOURNAL_FILENAME, JOURNAL_V2_FILENAME } from '../src/core/persistence/evidence-layout.js';
import { firmwareUpdateJournalV1Schema } from '../src/core/persistence/evidence-schemas-v1.js';
import { firmwareTargetV2Sha256, firmwareUpdateJournalV2Schema } from '../src/core/persistence/evidence-schemas-v2.js';
import { FirmwareTransactionStore } from '../src/core/persistence/firmware-transaction-store.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

const cdcCandidate: PortCandidate = {
  id: '/dev/tty.CDC407:CDC407:0483:5740', path: '/dev/tty.CDC407', vendorId: '0483', productId: '5740', serialNumber: 'CDC407', usbMatch: 'exact-zs407-cdc',
};
const dfuLine = 'Found DFU: [0483:df11] ver=2200, devnum=5, cfg=1, intf=0, path="1-1", alt=0, name="@Internal Flash  /0x08000000/128*002Kg", serial="DFU407"';

describe('FirmwareUpdater transaction boundaries', () => {
  it('normalizes an interrupted pre-write download to a persisted retryable failure', async () => {
    const directory = await temporary();
    const interrupted = firmwareUpdateJournalV2Schema.parse({
      schemaVersion: 2,
      targetId: OEM_ZS407_FIRMWARE_TARGET.targetId,
      targetSha256: firmwareTargetV2Sha256(OEM_ZS407_FIRMWARE_TARGET),
      writtenAt: new Date().toISOString(),
      state: {
        phase: 'downloading',
        target: OEM_ZS407_FIRMWARE_TARGET,
        targetRelation: 'different-supported',
        writeIntent: 'update-oem',
        updateAvailable: true,
        current: {
          version: 'tinySA4_v1.4-217-gc5dd31f',
          revision: 'c5dd31f',
          qualification: 'supported-oem',
        },
        dfuUtility: { available: false },
        dfuDevice: { detected: false, count: 0 },
        writeDisposition: 'not-started',
      },
    });
    await writeFile(join(directory, JOURNAL_V2_FILENAME), JSON.stringify(interrupted, null, 2), { flag: 'wx' });
    const updater = new FirmwareUpdater(directory, new FakeFirmwareDevice(), runtimeFixture(async () => successfulTransfer()));

    expect(await updater.state()).toMatchObject({
      phase: 'failed',
      writeDisposition: 'not-started',
      error: expect.stringMatching(/ended during firmware download.*no write began/i),
    });
    expect(JSON.parse(await readFile(join(directory, JOURNAL_V2_FILENAME), 'utf8'))).toMatchObject({
      state: { phase: 'failed', writeDisposition: 'not-started' },
    });
    await expect(updater.download()).resolves.toMatchObject({ phase: 'verified' });
    expect(await present(join(directory, 'firmware-write.lock'))).toBe(false);
  });

  it('migrates an unprepared v1 session before recording new v2 preflight evidence', async () => {
    const directory = await temporary();
    const legacy = firmwareUpdateJournalV1Schema.parse({
      schemaVersion: 1,
      targetVersion: OEM_ZS407_FIRMWARE_RELEASE.version,
      writtenAt: new Date().toISOString(),
      state: {
        phase: 'available',
        target: OEM_ZS407_FIRMWARE_RELEASE,
        updateAvailable: true,
        current: {
          version: 'tinySA4_v1.4-217-gc5dd31f',
          revision: 'c5dd31f',
          sourceCommit: ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT,
          qualification: 'supported-oem',
        },
        dfuUtility: { available: false },
        dfuDevice: { detected: false, count: 0 },
        writeDisposition: 'not-started',
      },
    });
    await writeFile(join(directory, JOURNAL_FILENAME), JSON.stringify(legacy, null, 2), { flag: 'wx' });
    const updater = new FirmwareUpdater(directory, new FakeFirmwareDevice(), runtimeFixture(async () => successfulTransfer()));

    expect(await updater.state()).toMatchObject({ phase: 'available', target: { kind: 'oem' }, writeIntent: 'update-oem' });
    await updater.download();
    const prepared = await updater.prepare(validPreflight());

    expect(prepared).toMatchObject({ phase: 'awaiting-dfu', preparation: { id: expect.any(String) } });
    await expect(readFile(join(directory, JOURNAL_FILENAME)).then(() => true, () => false)).resolves.toBe(false);
    expect(JSON.parse(await readFile(join(directory, JOURNAL_V2_FILENAME), 'utf8'))).toMatchObject({
      schemaVersion: 2,
      targetId: 'oem-zs407-c979386',
      state: { phase: 'awaiting-dfu', preparation: { id: prepared.preparation!.id } },
    });
    expect(JSON.parse(await readFile(join(directory, `preflight-${prepared.preparation!.id}.json`), 'utf8'))).toMatchObject({
      schemaVersion: 2,
      target: { kind: 'oem' },
    });
    expect(await inspectFirmwareSafetyEvidence(directory)).toEqual([]);
  });

  it('rejects a substituted device adapter that violates the exact screen-frame contract', async () => {
    const directory = await temporary();
    const device = new FakeFirmwareDevice({ screenBytes: 4 });
    const updater = new FirmwareUpdater(directory, device, runtimeFixture(async () => successfulTransfer()));

    expect(await updater.state()).toMatchObject({ phase: 'available' });
    await updater.download();
    await expect(updater.prepare({
      selfTestPassed: true,
      selfTestProcedure: OEM_ZS407_SELF_TEST_PROCEDURE.id,
      configurationDisposition: 'new-device-unchanged',
      rfPortsDisconnected: true,
      onlyUsbDeviceConnected: true,
    })).rejects.toThrow(/screen frame must contain exactly/i);
    expect(updater.snapshot()).toMatchObject({ phase: 'failed', writeDisposition: 'not-started' });
  });

  it('persists lock and started journal before exact selected dfu-util argv, then archives only after reboot proof', async () => {
    let directory = '';
    let observedArgs: readonly string[] = [];
    let inheritedDescriptor: number | undefined;
    let journalBeforeSpawn: unknown;
    let lockBeforeSpawn = false;
    const device = new FakeFirmwareDevice();
    const fixture = await readyFixture(device, async (_file, args, _duration, onProgress, firmware) => {
      observedArgs = args;
      inheritedDescriptor = firmware.descriptor;
      journalBeforeSpawn = JSON.parse(await readFile(join(directory, 'firmware-update-journal-v2.json'), 'utf8'));
      lockBeforeSpawn = await present(join(directory, 'firmware-write.lock'));
      onProgress({ operation: 'erase', percent: 100 });
      onProgress({ operation: 'download', percent: 100 });
      return successfulTransfer();
    });
    directory = fixture.directory;

    const completed = await fixture.updater.flash({ preparationId: fixture.preparationId, confirmation: 'FLASH VERIFIED OEM FIRMWARE' });

    expect(lockBeforeSpawn).toBe(true);
    expect(journalBeforeSpawn).toMatchObject({ state: { phase: 'flashing', writeDisposition: 'started', writeStartedAt: expect.any(String) } });
    expect(observedArgs).toEqual([
      '-d', '0483:df11', '-p', '1-1', '-S', 'DFU407', '-a', '0', '-s', '0x08000000:leave',
    ]);
    expect(inheritedDescriptor).toEqual(expect.any(Number));
    expect(inheritedDescriptor).toBeGreaterThan(2);
    expect(completed).toMatchObject({ phase: 'completed', writeDisposition: 'completed', current: { revision: 'c979386' } });
    expect(await present(join(directory, 'firmware-write.lock'))).toBe(false);
    expect(await present(join(directory, 'firmware-update-journal-v2.json'))).toBe(false);
    const ledger = await readdir(join(directory, 'completed-ledger-v2'));
    expect(ledger).toEqual([`device-407-preparation-${fixture.preparationId}.json`]);
    expect(JSON.parse(await readFile(join(directory, 'completed-ledger-v2', ledger[0]!), 'utf8'))).toMatchObject({ state: { phase: 'completed', completedAt: expect.any(String) } });
    expect(await inspectFirmwareSafetyEvidence(directory)).toEqual([]);
  });

  it('retains a globally blocking started journal and lock when dfu-util fails after spawn', async () => {
    const device = new FakeFirmwareDevice();
    const fixture = await readyFixture(device, async () => { throw new Error('dfu-util exited with code 74: transfer failed'); });

    await expect(fixture.updater.flash({ preparationId: fixture.preparationId, confirmation: 'FLASH VERIFIED OEM FIRMWARE' })).rejects.toThrow(/do not flash again.*code 74/i);
    expect(fixture.updater.snapshot()).toMatchObject({ phase: 'failed', writeDisposition: 'started' });
    expect(await present(join(fixture.directory, 'firmware-write.lock'))).toBe(true);
    expect(JSON.parse(await readFile(join(fixture.directory, 'firmware-update-journal-v2.json'), 'utf8'))).toMatchObject({ state: { phase: 'failed', writeDisposition: 'started' } });

    const recovered = new FirmwareUpdater(fixture.directory, new FakeFirmwareDevice({ disconnected: true }), fixture.runtime);
    expect(await recovered.state()).toMatchObject({ phase: 'failed', writeDisposition: 'started' });
    await expect(recovered.detectDfu()).rejects.toThrow(/write attempt already began/i);
  });

  it('retains the owner lock when an exception follows durable write-admission persistence', async () => {
    let spawned = false;
    const device = new FakeFirmwareDevice();
    const directory = await temporary();
    const updater = new FirmwareUpdater(
      directory,
      device,
      runtimeFixture(async () => { spawned = true; return successfulTransfer(); }),
      { afterWriteAdmissionPersist: async () => { throw new Error('simulated post-persist interruption'); } },
    );
    expect(await updater.state()).toMatchObject({ phase: 'available' });
    await updater.download();
    const prepared = await updater.prepare({
      selfTestPassed: true,
      selfTestProcedure: OEM_ZS407_SELF_TEST_PROCEDURE.id,
      configurationDisposition: 'new-device-unchanged',
      rfPortsDisconnected: true,
      onlyUsbDeviceConnected: true,
    });
    await updater.detectDfu();

    await expect(updater.flash({ preparationId: prepared.preparation!.id, confirmation: 'FLASH VERIFIED OEM FIRMWARE' }))
      .rejects.toThrow(/cleanup failed.*admission persistence was attempted/i);

    expect(spawned).toBe(false);
    expect(await present(join(directory, 'firmware-write.lock'))).toBe(true);
    expect(JSON.parse(await readFile(join(directory, 'firmware-update-journal-v2.json'), 'utf8')))
      .toMatchObject({ state: { phase: 'flashing', writeDisposition: 'started' } });
    expect(updater.snapshot()).toMatchObject({ phase: 'failed', writeDisposition: 'indeterminate' });
  });

  it('does not let a write-session capability persist another preparation', async () => {
    const fixture = await readyFixture(new FakeFirmwareDevice(), async () => successfulTransfer());
    const state = fixture.updater.snapshot();
    const identity = state.dfuDevice.identity!;
    const store = new FirmwareTransactionStore(fixture.directory);
    await store.recover();
    const session = await store.acquireWriteSession(fixture.preparationId, identity);
    const writeStartedAt = new Date().toISOString();
    const admitted = {
      ...state,
      phase: 'flashing' as const,
      writeDisposition: 'started' as const,
      writeStartedAt,
      flashProgress: { stage: 'preparing' as const, percent: 0, updatedAt: writeStartedAt },
    };
    await session.admitWrite(admitted);

    await expect(session.persist({
      ...admitted,
      preparation: { ...admitted.preparation!, id: '018f61e4-9020-7d42-909d-68b60f08e900' },
    })).rejects.toThrow(/does not match the admitted firmware write session capability/i);
    expect(await present(join(fixture.directory, 'firmware-write.lock'))).toBe(true);
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
    expect(await present(join(fixture.directory, 'firmware-update-journal-v2.json'))).toBe(true);
    expect(await present(join(fixture.directory, 'completed-ledger-v2'))).toBe(false);
  });

  it('rejects a target-matching post-flash snapshot that never reaches ready', async () => {
    const disconnecting = { ...targetSnapshot(cdcCandidate, 407), connection: 'disconnecting' as const };
    const fixture = await readyFixture(new FakeFirmwareDevice({ postFlashSnapshot: disconnecting }), async () => successfulTransfer());

    await expect(fixture.updater.flash({
      preparationId: fixture.preparationId,
      confirmation: 'FLASH VERIFIED OEM FIRMWARE',
    })).rejects.toThrow(/write completed but post-flash verification failed.*did not reach an admitted ready state/i);
    expect(fixture.updater.snapshot()).toMatchObject({ phase: 'failed', writeDisposition: 'completed' });
    expect(await present(join(fixture.directory, 'firmware-write.lock'))).toBe(true);
    expect(await present(join(fixture.directory, 'completed-ledger-v2'))).toBe(false);
  });

  it('rejects multiple exact post-flash ZS407 candidates even when one serial matches preflight', async () => {
    const other = {
      ...cdcCandidate,
      id: '/dev/tty.CDC999:OTHER:0483:5740',
      path: '/dev/tty.CDC999',
      serialNumber: 'OTHER',
    };
    const fixture = await readyFixture(new FakeFirmwareDevice({ postFlashCandidates: [cdcCandidate, other] }), async () => successfulTransfer());

    await expect(fixture.updater.flash({
      preparationId: fixture.preparationId,
      confirmation: 'FLASH VERIFIED OEM FIRMWARE',
    })).rejects.toThrow(/write completed but post-flash verification failed.*found 2 exact ZS407 candidates/i);
    expect(fixture.updater.snapshot()).toMatchObject({ phase: 'failed', writeDisposition: 'completed' });
    expect(await present(join(fixture.directory, 'firmware-write.lock'))).toBe(true);
    expect(await present(join(fixture.directory, 'completed-ledger-v2'))).toBe(false);
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
    expect(await present(join(fixture.directory, 'completed-ledger-v2'))).toBe(false);
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
    const winningJournal = await readFile(join(fixture.directory, 'firmware-update-journal-v2.json'), 'utf8');
    await expect(stale.detectDfu()).rejects.toThrow(/shared firmware safety evidence|shared firmware write boundary/i);
    expect(await readFile(join(fixture.directory, 'firmware-update-journal-v2.json'), 'utf8')).toBe(winningJournal);
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
      runDfuExecutable: async () => { spawnCount += 1; return successfulTransfer(); },
    };
    const stale = await loadReadyPeer(fixture.directory, staleRuntime, {
      beforeWriteLockAcquire: async () => { stalePaused(); await resume; },
    });
    const winner = await loadReadyPeer(fixture.directory, fixture.runtime);

    const staleFlash = stale.flash({ preparationId: fixture.preparationId, confirmation: 'FLASH VERIFIED OEM FIRMWARE' });
    await paused;
    await expect(winner.flash({ preparationId: fixture.preparationId, confirmation: 'FLASH VERIFIED OEM FIRMWARE' })).resolves.toMatchObject({ phase: 'completed' });
    const flatLedgerPath = join(fixture.directory, 'completed-ledger-v2', `device-407-preparation-${fixture.preparationId}.json`);
    const nestedLedgerDirectory = join(fixture.directory, 'completed-ledger-v2', 'archive', '2026');
    await mkdir(nestedLedgerDirectory, { recursive: true });
    const ledgerPath = join(nestedLedgerDirectory, `device-407-preparation-${fixture.preparationId}.json`);
    await rename(flatLedgerPath, ledgerPath);
    const winningLedger = await readFile(ledgerPath, 'utf8');

    releaseStale();
    await expect(staleFlash).rejects.toThrow(/permanently blocked.*did not modify the shared journal/i);
    expect(stale.snapshot()).toMatchObject({ phase: 'failed', writeDisposition: 'indeterminate' });
    expect(await present(join(fixture.directory, 'firmware-write.lock'))).toBe(false);
    expect(await present(join(fixture.directory, 'firmware-update-journal-v2.json'))).toBe(false);
    expect(await readFile(ledgerPath, 'utf8')).toBe(winningLedger);
    expect(spawnCount).toBe(1);
  });

  it('rejects a resurrected ready journal when the same preparation already has an immutable ledger', async () => {
    let spawnCount = 0;
    const fixture = await readyFixture(new FakeFirmwareDevice(), async () => { spawnCount += 1; return successfulTransfer(); });
    const readyJournal = await readFile(join(fixture.directory, 'firmware-update-journal-v2.json'));
    await expect(fixture.updater.flash({ preparationId: fixture.preparationId, confirmation: 'FLASH VERIFIED OEM FIRMWARE' })).resolves.toMatchObject({ phase: 'completed' });
    const flatLedgerPath = join(fixture.directory, 'completed-ledger-v2', `device-407-preparation-${fixture.preparationId}.json`);
    const nestedLedgerDirectory = join(fixture.directory, 'completed-ledger-v2', 'archive', '2026');
    await mkdir(nestedLedgerDirectory, { recursive: true });
    const ledgerPath = join(nestedLedgerDirectory, `device-407-preparation-${fixture.preparationId}.json`);
    await rename(flatLedgerPath, ledgerPath);
    const winningLedger = await readFile(ledgerPath, 'utf8');
    for (const name of await readdir(fixture.directory)) {
      if (name.startsWith(`result-${fixture.preparationId}-`)) await rm(join(fixture.directory, name));
    }
    await writeFile(join(fixture.directory, 'firmware-update-journal-v2.json'), readyJournal, { flag: 'wx' });

    const resurrected = new FirmwareUpdater(fixture.directory, new FakeFirmwareDevice({ disconnected: true }), fixture.runtime);
    expect(await resurrected.state()).toMatchObject({ phase: 'failed', writeDisposition: 'indeterminate' });
    await expect(resurrected.detectDfu()).rejects.toThrow(/indeterminate/i);
    const resurrectedJournal = await readFile(join(fixture.directory, 'firmware-update-journal-v2.json'), 'utf8');
    expect(await readFile(join(fixture.directory, 'firmware-update-journal-v2.json'), 'utf8')).toBe(resurrectedJournal);
    expect(await readFile(ledgerPath, 'utf8')).toBe(winningLedger);
    expect(await present(join(fixture.directory, 'firmware-write.lock'))).toBe(false);
    expect(resurrected.snapshot()).toMatchObject({ phase: 'failed', writeDisposition: 'indeterminate' });
    expect(spawnCount).toBe(1);
  });

  it('does not overwrite a ready journal when another owner wins the exclusive lock first', async () => {
    let spawned = false;
    const fixture = await readyFixture(new FakeFirmwareDevice(), async () => { spawned = true; return successfulTransfer(); });
    const journalBefore = await readFile(join(fixture.directory, 'firmware-update-journal-v2.json'), 'utf8');
    await writeFile(join(fixture.directory, 'firmware-write.lock'), '{"owner":"other-process"}', { flag: 'wx' });

    await expect(fixture.updater.flash({ preparationId: fixture.preparationId, confirmation: 'FLASH VERIFIED OEM FIRMWARE' })).rejects.toThrow(/permanently blocked.*did not modify the shared journal/i);
    expect(spawned).toBe(false);
    expect(await readFile(join(fixture.directory, 'firmware-update-journal-v2.json'), 'utf8')).toBe(journalBefore);
    expect(fixture.updater.snapshot()).toMatchObject({ phase: 'failed', writeDisposition: 'indeterminate' });
  });

  it('revalidates immutable preflight linkage under the write lock before admitting any write', async () => {
    let spawned = false;
    const fixture = await readyFixture(new FakeFirmwareDevice(), async () => { spawned = true; return successfulTransfer(); });
    const journalPath = join(fixture.directory, 'firmware-update-journal-v2.json');
    const journalBefore = await readFile(journalPath, 'utf8');
    const preflightPath = join(fixture.directory, `preflight-${fixture.preparationId}.json`);
    const tampered = JSON.parse(await readFile(preflightPath, 'utf8')) as { preparation: { screenSha256: string } };
    tampered.preparation.screenSha256 = '0'.repeat(64);
    await writeFile(preflightPath, JSON.stringify(tampered, null, 2));

    await expect(fixture.updater.flash({ preparationId: fixture.preparationId, confirmation: 'FLASH VERIFIED OEM FIRMWARE' }))
      .rejects.toThrow(/permanently blocked.*preflight evidence/i);

    expect(spawned).toBe(false);
    expect(await readFile(journalPath, 'utf8')).toBe(journalBefore);
    expect(await present(join(fixture.directory, 'firmware-write.lock'))).toBe(false);
    expect(fixture.updater.snapshot()).toMatchObject({ phase: 'failed', writeDisposition: 'indeterminate' });
  });

  it('retains a write lock whose non-token fields changed instead of unlinking it as owned', async () => {
    let spawned = false;
    const device = new FakeFirmwareDevice();
    const directory = await temporary();
    const runtime = runtimeFixture(async () => { spawned = true; return successfulTransfer(); });
    const updater = new FirmwareUpdater(directory, device, runtime, {
      afterWriteLockAcquire: async () => {
        const path = join(directory, 'firmware-write.lock');
        const changed = JSON.parse(await readFile(path, 'utf8')) as { acquiredAt: string };
        changed.acquiredAt = '2026-07-14T00:00:00.000Z';
        await writeFile(path, JSON.stringify(changed, null, 2));
      },
    });
    expect(await updater.state()).toMatchObject({ phase: 'available' });
    await updater.download();
    const prepared = await updater.prepare({
      selfTestPassed: true,
      selfTestProcedure: OEM_ZS407_SELF_TEST_PROCEDURE.id,
      configurationDisposition: 'new-device-unchanged',
      rfPortsDisconnected: true,
      onlyUsbDeviceConnected: true,
    });
    await updater.detectDfu();

    await expect(updater.flash({ preparationId: prepared.preparation!.id, confirmation: 'FLASH VERIFIED OEM FIRMWARE' }))
      .rejects.toThrow(/cleanup failed.*record changed/i);

    expect(spawned).toBe(false);
    expect(await present(join(directory, 'firmware-write.lock'))).toBe(true);
    expect(updater.snapshot()).toMatchObject({ phase: 'failed', writeDisposition: 'indeterminate' });
  });

  it('installs an admitted local custom target with distinct confirmation and self-contained v2 evidence', async () => {
    const directory = await temporary();
    const { artifact, bytes, target } = customArtifactFixture('/app-owned/custom.bin');
    let inheritedDescriptor: number | undefined;
    let flashArguments: readonly string[] = [];
    const device = new FakeFirmwareDevice({ postFlashCustomTarget: target });
    const updater = new FirmwareUpdater(directory, device, runtimeFixture(async (_file, args, _duration, _progress, firmware) => {
      flashArguments = args;
      inheritedDescriptor = firmware.descriptor;
      return successfulTransfer();
    }));

    expect(await updater.state()).toMatchObject({ phase: 'available', writeIntent: 'update-oem' });
    expect(await updater.admitLocalCustomTarget(target, artifact)).toMatchObject({
      phase: 'verified', target: { kind: 'local-custom', targetId: target.targetId },
      targetRelation: 'different-supported', writeIntent: 'install-custom',
      artifact: { sha256: target.sha256, sizeBytes: bytes.byteLength },
    });
    const prepared = await updater.prepare(validPreflight());
    await updater.detectDfu();
    await expect(updater.flash({ preparationId: prepared.preparation!.id, confirmation: 'FLASH VERIFIED OEM FIRMWARE' }))
      .rejects.toThrow(/must be exactly FLASH VERIFIED CUSTOM FIRMWARE/i);
    expect(await present(join(directory, 'firmware-write.lock'))).toBe(false);

    const completed = await updater.flash({
      preparationId: prepared.preparation!.id,
      confirmation: 'FLASH VERIFIED CUSTOM FIRMWARE',
    });
    expect(flashArguments).not.toContain('-D');
    expect(inheritedDescriptor).toBe(41);
    expect(completed).toMatchObject({
      phase: 'completed', targetRelation: 'same', writeIntent: 'install-custom', updateAvailable: false,
      current: { version: target.version, revision: target.revision, qualification: 'custom-unqualified' },
    });
    const ledgerName = (await readdir(join(directory, 'completed-ledger-v2')))[0]!;
    const ledger = JSON.parse(await readFile(join(directory, 'completed-ledger-v2', ledgerName), 'utf8')) as {
      schemaVersion: number; target: unknown; state: { target: LocalCustomFirmwareTarget };
    };
    expect(ledger).toMatchObject({
      schemaVersion: 2,
      targetId: target.targetId,
      state: { target: { kind: 'local-custom', sourceCommit: target.sourceCommit, manifestSha256: target.manifestSha256 } },
    });
    const verifiedAudit = JSON.parse(await readFile(
      join(directory, `result-${prepared.preparation!.id}-verified-complete.json`), 'utf8',
    )) as { value: { identity: Record<string, unknown> } };
    expect(verifiedAudit.value.identity).not.toHaveProperty('firmwareSourceCommit');
    expect(await inspectFirmwareSafetyEvidence(directory)).toEqual([]);
  });

  it('does not treat matching custom version labels as proof of identical target bytes', async () => {
    const directory = await temporary();
    const fixture = customArtifactFixture('/app-owned/same-labels.bin');
    const updater = new FirmwareUpdater(
      directory,
      new FakeFirmwareDevice({ initialCustomTarget: fixture.target }),
      runtimeFixture(async () => successfulTransfer()),
    );

    expect(await updater.state()).toMatchObject({
      phase: 'available',
      target: { kind: 'oem' },
      targetRelation: 'custom-current',
      writeIntent: 'restore-oem',
    });
    expect(await updater.admitLocalCustomTarget(fixture.target, fixture.artifact)).toMatchObject({
      phase: 'verified',
      target: { kind: 'local-custom' },
      targetRelation: 'custom-current',
      writeIntent: 'install-custom',
      updateAvailable: true,
    });
    await expect(updater.prepare(validPreflight())).resolves.toMatchObject({ phase: 'awaiting-dfu' });
  });

  it('retains valid completed custom intent when completion archival fails after reboot proof', async () => {
    const directory = await temporary();
    const fixture = customArtifactFixture('/app-owned/archive-failure.bin');
    const updater = new FirmwareUpdater(
      directory,
      new FakeFirmwareDevice({
        postFlashCustomTarget: fixture.target,
        afterConnect: async () => {
          await writeFile(join(directory, 'completed-ledger-v2'), 'forced non-directory collision', { flag: 'wx' });
        },
      }),
      runtimeFixture(async () => successfulTransfer()),
    );
    await updater.state();
    await updater.admitLocalCustomTarget(fixture.target, fixture.artifact);
    const prepared = await updater.prepare(validPreflight());
    await updater.detectDfu();

    await expect(updater.flash({
      preparationId: prepared.preparation!.id,
      confirmation: 'FLASH VERIFIED CUSTOM FIRMWARE',
    })).rejects.toThrow(/write completed.*post-flash verification failed/i);

    expect(updater.snapshot()).toMatchObject({
      phase: 'failed',
      writeDisposition: 'completed',
      targetRelation: 'same',
      writeIntent: 'install-custom',
      current: { version: fixture.target.version, revision: fixture.target.revision },
      completedAt: expect.any(String),
    });
    expect(JSON.parse(await readFile(join(directory, JOURNAL_V2_FILENAME), 'utf8'))).toMatchObject({
      state: { phase: 'failed', writeDisposition: 'completed', writeIntent: 'install-custom' },
    });
    expect(await present(join(directory, 'firmware-write.lock'))).toBe(true);
    await rm(join(directory, 'completed-ledger-v2'));
    expect(await inspectFirmwareSafetyEvidence(directory)).toEqual([]);
  });

  it('makes an abnormal recovered unprepared custom journal require native re-admission', async () => {
    const directory = await temporary();
    const fixture = customArtifactFixture('/path-is-never-persisted.bin');
    const writtenAt = new Date().toISOString();
    const journal = firmwareUpdateJournalV2Schema.parse({
      schemaVersion: 2,
      targetId: fixture.target.targetId,
      targetSha256: firmwareTargetV2Sha256(fixture.target),
      writtenAt,
      state: {
        phase: 'verified',
        target: fixture.target,
        targetRelation: 'different-supported',
        writeIntent: 'install-custom',
        updateAvailable: true,
        current: {
          version: 'tinySA4_v1.4-217-gc5dd31f',
          revision: 'c5dd31f',
          qualification: 'supported-oem',
        },
        artifact: {
          targetId: fixture.target.targetId,
          sizeBytes: fixture.target.sizeBytes,
          sha256: fixture.target.sha256,
          verifiedAt: writtenAt,
        },
        dfuUtility: { available: false },
        dfuDevice: { detected: false, count: 0 },
        writeDisposition: 'not-started',
      },
    });
    await writeFile(join(directory, JOURNAL_V2_FILENAME), JSON.stringify(journal, null, 2), { flag: 'wx' });
    const updater = new FirmwareUpdater(
      directory,
      new FakeFirmwareDevice({ disconnected: true }),
      runtimeFixture(async () => successfulTransfer()),
    );

    expect(await updater.state()).toMatchObject({
      phase: 'failed',
      target: { kind: 'local-custom', targetId: fixture.target.targetId },
      writeDisposition: 'not-started',
      error: expect.stringMatching(/no in-process artifact capability.*re-select the manifest/i),
    });
    expect(JSON.parse(await readFile(join(directory, JOURNAL_V2_FILENAME), 'utf8'))).toMatchObject({
      state: { phase: 'failed', target: { targetId: fixture.target.targetId } },
    });
  });

  it('does not admit DFU actions for a recovered prepared custom target until its exact artifact capability is rebound', async () => {
    const directory = await temporary();
    const fixture = customArtifactFixture('/app-owned/recovered-prepared.bin');
    const runtime = runtimeFixture(async () => successfulTransfer());
    const original = new FirmwareUpdater(directory, new FakeFirmwareDevice(), runtime);
    await original.state();
    await original.admitLocalCustomTarget(fixture.target, fixture.artifact);
    const prepared = await original.prepare(validPreflight());
    expect(prepared.phase).toBe('awaiting-dfu');

    const recovered = new FirmwareUpdater(
      directory,
      new FakeFirmwareDevice({ disconnected: true }),
      runtime,
    );
    await expect(recovered.state()).resolves.toMatchObject({
      phase: 'failed',
      target: { kind: 'local-custom' },
      preparation: { id: prepared.preparation!.id },
      dfuDevice: { detected: false, count: 0 },
      writeDisposition: 'not-started',
      error: expect.stringMatching(/no in-process artifact capability.*re-admit/i),
    });
    await expect(recovered.detectDfu()).rejects.toThrow(/artifact capability is not bound/i);
    await expect(recovered.refreshPrerequisites()).rejects.toThrow(/artifact capability is not bound/i);

    await expect(recovered.admitLocalCustomTarget(fixture.target, fixture.artifact)).resolves.toMatchObject({
      phase: 'awaiting-dfu',
      preparation: { id: prepared.preparation!.id },
      dfuDevice: { detected: false, count: 0 },
      error: undefined,
    });
    expect(JSON.parse(await readFile(join(directory, JOURNAL_V2_FILENAME), 'utf8'))).toMatchObject({
      state: { phase: 'awaiting-dfu', dfuDevice: { detected: false, count: 0 } },
    });
    await expect(recovered.detectDfu()).resolves.toMatchObject({ phase: 'ready-to-flash' });
  });

  it('reopens and hashes the custom artifact immediately before dfu-util and retains admission on drift', async () => {
    const directory = await temporary();
    const fixture = customArtifactFixture('/app-owned/custom-drift.bin');
    let reads = 0;
    let spawned = false;
    const artifact: AdmittedFirmwareArtifact = Object.freeze({
      ...fixture.artifact,
      openVerified: async () => {
        reads += 1;
        const bytes = fixture.bytes.slice();
        // Admission, preparation, and the first flash check are valid. Change
        // only the final check adjacent to child-process launch.
        if (reads === 4) bytes[100] = bytes[100]! ^ 1;
        return fakeVerifiedArtifact(bytes);
      },
    });
    const updater = new FirmwareUpdater(
      directory,
      new FakeFirmwareDevice({ postFlashCustomTarget: fixture.target }),
      runtimeFixture(async () => { spawned = true; return successfulTransfer(); }),
    );
    await updater.state();
    await updater.admitLocalCustomTarget(fixture.target, artifact);
    const prepared = await updater.prepare(validPreflight());
    await updater.detectDfu();

    await expect(updater.flash({
      preparationId: prepared.preparation!.id,
      confirmation: 'FLASH VERIFIED CUSTOM FIRMWARE',
    })).rejects.toThrow(/write may have begun.*sha-256/i);

    expect(reads).toBe(4);
    expect(spawned).toBe(false);
    expect(updater.snapshot()).toMatchObject({ phase: 'failed', writeDisposition: 'started' });
    expect(await present(join(directory, 'firmware-write.lock'))).toBe(true);
  });

  it('keeps the final verified artifact descriptor open until the dfu-util child contract settles', async () => {
    const directory = await temporary();
    const fixture = customArtifactFixture('/app-owned/custom-held-open.bin');
    const closed = new Set<number>();
    let nextDescriptor = 50;
    let openCount = 0;
    let finalArtifactOpen = false;
    const boundaryEvents: string[] = [];
    const artifact: AdmittedFirmwareArtifact = Object.freeze({
      targetId: fixture.target.targetId,
      openVerified: async () => {
        const descriptor = nextDescriptor++;
        openCount += 1;
        const finalOpen = openCount === 4;
        if (finalOpen) {
          finalArtifactOpen = true;
          boundaryEvents.push('artifact-open-and-hash');
        }
        let isClosed = false;
        return {
          descriptor,
          bytes: fixture.bytes.slice(),
          assertStable: async () => {
            if (isClosed) throw new Error('descriptor closed too early');
            if (finalOpen) boundaryEvents.push('artifact-final-fstat');
          },
          close: async () => {
            if (isClosed) return;
            isClosed = true;
            closed.add(descriptor);
          },
        };
      },
    });
    let releaseChild!: () => void;
    let childStarted!: () => void;
    const started = new Promise<void>((resolve) => { childStarted = resolve; });
    const runtime = {
      ...runtimeFixture(async (_file, _args, _duration, _progress, firmware) => {
        boundaryEvents.push('dfu-spawn');
        expect(closed.has(firmware.descriptor)).toBe(false);
        childStarted();
        await new Promise<void>((resolve) => { releaseChild = resolve; });
        expect(closed.has(firmware.descriptor)).toBe(false);
        return successfulTransfer();
      }),
      runExecutable: async (_file: string, args: readonly string[]) => {
        if (args.includes('--version')) return { stdout: 'dfu-util 0.11', stderr: '' };
        if (finalArtifactOpen) boundaryEvents.push('final-dfu-list');
        return { stdout: dfuLine, stderr: '' };
      },
    };
    const updater = new FirmwareUpdater(
      directory,
      new FakeFirmwareDevice({ postFlashCustomTarget: fixture.target }),
      runtime,
    );
    await updater.state();
    await updater.admitLocalCustomTarget(fixture.target, artifact);
    const prepared = await updater.prepare(validPreflight());
    await updater.detectDfu();

    const flashing = updater.flash({
      preparationId: prepared.preparation!.id,
      confirmation: 'FLASH VERIFIED CUSTOM FIRMWARE',
    });
    await started;
    const childDescriptor = nextDescriptor - 1;
    expect(closed.has(childDescriptor)).toBe(false);
    releaseChild();
    await expect(flashing).resolves.toMatchObject({ phase: 'completed' });
    expect(closed.has(childDescriptor)).toBe(true);
    expect(boundaryEvents).toEqual([
      'artifact-open-and-hash',
      'final-dfu-list',
      'artifact-final-fstat',
      'dfu-spawn',
    ]);
  });

  it('restores pinned OEM firmware from a currently custom ZS407 instead of disabling writes', async () => {
    const directory = await temporary();
    const currentCustom = customArtifactFixture('/app-owned/current.bin').target;
    const updater = new FirmwareUpdater(
      directory,
      new FakeFirmwareDevice({ initialCustomTarget: currentCustom }),
      runtimeFixture(async () => successfulTransfer()),
    );
    expect(await updater.state()).toMatchObject({
      phase: 'available', target: { kind: 'oem' }, targetRelation: 'custom-current', writeIntent: 'restore-oem',
    });
    await updater.download();
    const prepared = await updater.prepare(validPreflight());
    await updater.detectDfu();
    await expect(updater.flash({
      preparationId: prepared.preparation!.id,
      confirmation: 'FLASH VERIFIED OEM FIRMWARE',
    })).resolves.toMatchObject({
      phase: 'completed', writeIntent: 'restore-oem', current: { qualification: 'supported-oem', revision: 'c979386' },
    });
    expect(await inspectFirmwareSafetyEvidence(directory)).toEqual([]);
  });

  it('retains the lock when a custom write reboots with the wrong reported revision', async () => {
    const directory = await temporary();
    const fixture = customArtifactFixture('/app-owned/custom-wrong-revision.bin');
    const updater = new FirmwareUpdater(
      directory,
      new FakeFirmwareDevice({ postFlashCustomTarget: fixture.target, postFlashRevision: '2222222' }),
      runtimeFixture(async () => successfulTransfer()),
    );
    await updater.state();
    await updater.admitLocalCustomTarget(fixture.target, fixture.artifact);
    const prepared = await updater.prepare(validPreflight());
    await updater.detectDfu();
    await expect(updater.flash({
      preparationId: prepared.preparation!.id,
      confirmation: 'FLASH VERIFIED CUSTOM FIRMWARE',
    })).rejects.toThrow(/write completed but post-flash verification failed.*expected.*1111111/i);
    expect(updater.snapshot()).toMatchObject({ phase: 'failed', writeDisposition: 'completed' });
    expect(await present(join(directory, 'firmware-write.lock'))).toBe(true);
    expect(await present(join(directory, 'completed-ledger-v2'))).toBe(false);
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

async function loadReadyPeer(
  directory: string,
  runtime: Partial<FirmwareUpdaterRuntime>,
  testHooks: FirmwareUpdaterTestHooks = {},
): Promise<FirmwareUpdater> {
  const peer = new FirmwareUpdater(directory, new FakeFirmwareDevice({ disconnected: true }), runtime, testHooks);
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

function validPreflight() {
  return {
    selfTestPassed: true as const,
    selfTestProcedure: OEM_ZS407_SELF_TEST_PROCEDURE.id,
    configurationDisposition: 'new-device-unchanged' as const,
    rfPortsDisconnected: true as const,
    onlyUsbDeviceConnected: true as const,
  };
}

function customArtifactFixture(_path: string): {
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

function fakeVerifiedArtifact(bytes: Uint8Array) {
  return {
    descriptor: 41,
    bytes,
    assertStable: async () => undefined,
    close: async () => undefined,
  };
}

class FakeFirmwareDevice implements FirmwareUpdateDevice {
  #snapshot: DeviceSnapshot;
  constructor(private readonly options: {
    disconnected?: boolean;
    initialCustomTarget?: LocalCustomFirmwareTarget;
    postFlashCustomTarget?: LocalCustomFirmwareTarget;
    postFlashDeviceId?: number;
    postFlashFirmwareVersion?: string;
    postFlashRevision?: string;
    postFlashSnapshot?: DeviceSnapshot;
    postFlashCandidates?: PortCandidate[];
    screenBytes?: number;
    afterConnect?: () => Promise<void>;
  } = {}) {
    this.#snapshot = options.disconnected ? { connection: 'disconnected' }
      : options.initialCustomTarget ? customSnapshot(cdcCandidate, options.initialCustomTarget, 407)
        : outdatedSnapshot();
  }
  snapshot(): DeviceSnapshot { return structuredClone(this.#snapshot); }
  async readDiagnostics(): Promise<DeviceDiagnostics> {
    const identity = this.#snapshot.identity ?? outdatedSnapshot().identity!;
    return {
      identity,
      firmwareVersionResponse: identity.firmwareVersion,
      infoLines: ['tinySA ULTRA+ ZS407'],
      commands: ['version', 'info', 'help', 'mode', 'output', 'vbat', 'deviceid', 'capture'],
      telemetry: { batteryMillivolts: 4211, deviceId: 407, capturedAt: new Date().toISOString() },
      capturedAt: new Date().toISOString(),
    };
  }
  async captureScreen(): Promise<ScreenFrame> { return { width: 480, height: 320, format: 'rgb565le', pixels: new Uint8Array(this.options.screenBytes ?? SCREEN_BYTES), capturedAt: new Date().toISOString() }; }
  async disconnect(): Promise<void> { this.#snapshot = { connection: 'disconnected' }; }
  async listDevices(): Promise<PortCandidate[]> { return structuredClone(this.options.postFlashCandidates ?? [cdcCandidate]); }
  async connect(candidate: PortCandidate): Promise<DeviceSnapshot> {
    this.#snapshot = this.options.postFlashSnapshot ?? (this.options.postFlashCustomTarget
      ? customSnapshot(candidate, this.options.postFlashCustomTarget, this.options.postFlashDeviceId ?? 407, this.options.postFlashRevision)
      : targetSnapshot(candidate, this.options.postFlashDeviceId ?? 407, this.options.postFlashFirmwareVersion));
    await this.options.afterConnect?.();
    return this.snapshot();
  }
}

function outdatedSnapshot(): DeviceSnapshot {
  const capturedAt = new Date().toISOString();
  return {
    connection: 'ready',
    identity: {
      model: 'tinySA Ultra+ ZS407', hardwareVersion: 'V0.5.4 + ZS407', firmwareVersion: 'tinySA4_v1.4-217-gc5dd31f',
      firmwareReportedRevision: 'c5dd31f', firmwareSourceCommit: ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT, firmwareQualification: 'supported-oem',
      port: cdcCandidate, usbIdentityVerified: true,
    },
    telemetry: { batteryMillivolts: 4211, deviceId: 407, capturedAt },
    connectedAt: capturedAt,
  };
}

function targetSnapshot(candidate: PortCandidate, deviceId: number, firmwareVersion: string = OEM_ZS407_FIRMWARE_RELEASE.version): DeviceSnapshot {
  const capturedAt = new Date().toISOString();
  return {
    connection: 'ready',
    identity: {
      model: 'tinySA Ultra+ ZS407', hardwareVersion: 'V0.5.4 + ZS407', firmwareVersion,
      firmwareReportedRevision: OEM_ZS407_FIRMWARE_RELEASE.revision, firmwareSourceCommit: OEM_ZS407_FIRMWARE_RELEASE.sourceCommit, firmwareQualification: 'supported-oem',
      port: candidate, usbIdentityVerified: true,
    },
    telemetry: { batteryMillivolts: 4211, deviceId, capturedAt },
    connectedAt: capturedAt,
  };
}

function customSnapshot(
  candidate: PortCandidate,
  target: LocalCustomFirmwareTarget,
  deviceId: number,
  revision = target.revision,
): DeviceSnapshot {
  const capturedAt = new Date().toISOString();
  return {
    connection: 'ready',
    identity: {
      model: 'tinySA Ultra+ ZS407', hardwareVersion: 'V0.5.4 + ZS407', firmwareVersion: target.version,
      firmwareReportedRevision: revision, firmwareQualification: 'custom-unqualified', firmwareWarning: 'Locally built custom firmware',
      port: candidate, usbIdentityVerified: true,
    },
    telemetry: { batteryMillivolts: 4211, deviceId, capturedAt },
    connectedAt: capturedAt,
  };
}

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tinysa-flasher-transaction-'));
  directories.push(directory);
  return directory;
}

async function present(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
