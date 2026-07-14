import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OEM_ZS407_FIRMWARE_RELEASE, OEM_ZS407_SELF_TEST_PROCEDURE } from '../src/core/contracts.js';
import {
  inspectFirmwareSafetyEvidence,
  directoryChainToRoot,
  JOURNAL_FILENAME,
  MIGRATION_CONFLICT_FILENAME,
  MIGRATION_MARKER_FILENAME,
  migrateLegacyFirmwareState,
} from '../src/core/legacy-migration.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe('Atomizer safety-evidence migration', () => {
  it('is idempotent when no legacy state exists', async () => {
    const root = await temporary('flasher-empty-');
    const target = join(root, 'target');
    const legacy = join(root, 'legacy');
    expect((await migrateLegacyFirmwareState(target, [legacy])).status).toBe('none');
    const first = await readdir(target);
    expect((await migrateLegacyFirmwareState(target, [legacy])).status).toBe('none');
    expect(await readdir(target)).toEqual(first);
    expect(first).toEqual([MIGRATION_MARKER_FILENAME]);
  });

  it('copies the journal and safety artifacts without deleting the legacy source', async () => {
    const root = await temporary('flasher-import-');
    const target = join(root, 'target');
    const legacy = join(root, 'legacy');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(legacy, { recursive: true }));
    const journal = '{"schemaVersion":1,"state":{"phase":"available","writeDisposition":"not-started"}}';
    await writeFile(join(legacy, JOURNAL_FILENAME), journal);
    await writeFile(join(legacy, 'preflight-a5ada7f3-fbe3-41bd-83ac-a07028bc55f6.json'), '{"proof":true}');
    expect((await migrateLegacyFirmwareState(target, [legacy])).status).toBe('imported');
    expect(await readFile(join(target, JOURNAL_FILENAME), 'utf8')).toBe(journal);
    expect(await readFile(join(legacy, JOURNAL_FILENAME), 'utf8')).toBe(journal);
  });

  it('fails closed instead of selecting among conflicting journals', async () => {
    const root = await temporary('flasher-conflict-');
    const target = join(root, 'target');
    const first = join(root, 'first');
    const second = join(root, 'second');
    const { mkdir } = await import('node:fs/promises');
    await Promise.all([mkdir(first), mkdir(second)]);
    await writeFile(join(first, JOURNAL_FILENAME), '{"state":"started"}');
    await writeFile(join(second, JOURNAL_FILENAME), '{"state":"different"}');
    const result = await migrateLegacyFirmwareState(target, [first, second]);
    expect(result.status).toBe('conflict');
    expect(JSON.parse(await readFile(join(target, MIGRATION_CONFLICT_FILENAME), 'utf8')).reason).toMatch(/No safety history was selected/);
  });

  it('treats an orphan or multiple write lock as indeterminate safety evidence', async () => {
    const root = await temporary('flasher-locks-');
    const target = join(root, 'target');
    const orphan = join(root, 'orphan');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(orphan);
    await writeFile(join(orphan, 'firmware-write.lock'), '{"preparationId":"orphan"}');
    expect((await migrateLegacyFirmwareState(target, [orphan])).status).toBe('conflict');
    expect(JSON.parse(await readFile(join(target, MIGRATION_CONFLICT_FILENAME), 'utf8')).reason).toMatch(/Orphan firmware write lock/);

    const root2 = await temporary('flasher-two-locks-');
    const target2 = join(root2, 'target');
    const first = join(root2, 'first');
    const second = join(root2, 'second');
    await Promise.all([mkdir(first), mkdir(second)]);
    for (const directory of [first, second]) {
      await writeFile(join(directory, JOURNAL_FILENAME), '{"same":"journal"}');
      await writeFile(join(directory, 'firmware-write.lock'), '{"same":"lock"}');
    }
    expect((await migrateLegacyFirmwareState(target2, [first, second])).status).toBe('conflict');
    expect(JSON.parse(await readFile(join(target2, MIGRATION_CONFLICT_FILENAME), 'utf8')).reason).toMatch(/Multiple firmware write locks/);

    const root3 = await temporary('flasher-journal-mutex-');
    const target3 = join(root3, 'target');
    const legacy3 = join(root3, 'legacy');
    await mkdir(legacy3);
    await writeFile(join(legacy3, 'firmware-journal.lock'), '{"ownerToken":"interrupted"}');
    expect((await migrateLegacyFirmwareState(target3, [legacy3])).status).toBe('conflict');
    expect(JSON.parse(await readFile(join(target3, MIGRATION_CONFLICT_FILENAME), 'utf8')).reason).toMatch(/journal mutex/i);
  });

  it('unions nonconflicting safety artifacts from every legacy directory', async () => {
    const root = await temporary('flasher-union-');
    const target = join(root, 'target');
    const first = join(root, 'first');
    const second = join(root, 'second');
    const { mkdir } = await import('node:fs/promises');
    await Promise.all([mkdir(first), mkdir(second)]);
    const journal = '{"schemaVersion":1,"state":{"phase":"available","writeDisposition":"not-started"}}';
    await writeFile(join(first, JOURNAL_FILENAME), journal);
    await writeFile(join(second, JOURNAL_FILENAME), journal);
    const preflight = 'preflight-a5ada7f3-fbe3-41bd-83ac-a07028bc55f6.json';
    const result = 'result-a5ada7f3-fbe3-41bd-83ac-a07028bc55f6-download-verified.json';
    await writeFile(join(first, preflight), '{"preflight":true}');
    await writeFile(join(second, result), '{"result":true}');
    expect((await migrateLegacyFirmwareState(target, [first, second])).status).toBe('imported');
    expect(await readFile(join(target, preflight), 'utf8')).toBe('{"preflight":true}');
    expect(await readFile(join(target, result), 'utf8')).toBe('{"result":true}');
  });

  it('locks on orphan or internally inconsistent write audit evidence', async () => {
    const root = await temporary('flasher-audit-orphan-');
    const target = join(root, 'target');
    const legacy = join(root, 'legacy');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(legacy);
    const id = 'a5ada7f3-fbe3-41bd-83ac-a07028bc55f6';
    await writeFile(join(legacy, `result-${id}-write-started.json`), JSON.stringify({ schemaVersion: 1, stage: 'write-started', value: { preparationId: id } }));
    expect((await migrateLegacyFirmwareState(target, [legacy])).status).toBe('conflict');
    expect(JSON.parse(await readFile(join(target, MIGRATION_CONFLICT_FILENAME), 'utf8')).reason).toMatch(/Orphan write-started audit/);
  });

  it('does not let a loose or corrupt completed ledger legitimize write audit evidence', async () => {
    const root = await temporary('flasher-corrupt-ledger-');
    const target = join(root, 'target');
    const legacy = join(root, 'legacy');
    const ledger = join(legacy, 'completed-ledger-v1');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(ledger, { recursive: true });
    const id = 'a5ada7f3-fbe3-41bd-83ac-a07028bc55f6';
    await writeFile(join(legacy, `result-${id}-write-complete.json`), JSON.stringify({ schemaVersion: 1, stage: 'write-complete', value: { preparationId: id } }));
    await writeFile(join(ledger, `device-407-preparation-${id}.json`), JSON.stringify({ schemaVersion: 1, state: { phase: 'completed', writeDisposition: 'completed', preparation: { id } } }));
    expect((await migrateLegacyFirmwareState(target, [legacy])).status).toBe('conflict');
    expect(JSON.parse(await readFile(join(target, MIGRATION_CONFLICT_FILENAME), 'utf8')).reason).toMatch(/Malformed completed ledger/);
  });

  it('atomically migrates a valid completed legacy session with its supporting ledger and audits', async () => {
    const root = await temporary('flasher-completed-ledger-');
    const target = join(root, 'target');
    const legacy = join(root, 'legacy');
    const id = 'a5ada7f3-fbe3-41bd-83ac-a07028bc55f6';
    const ledgerDirectory = join(legacy, 'completed-ledger-v1', 'archive', '2026');
    const ledgerName = `device-407-preparation-${id}.json`;
    const { mkdir } = await import('node:fs/promises');
    await mkdir(ledgerDirectory, { recursive: true });
    const completedLedger = completedLedgerJson(id);
    await writeFile(join(ledgerDirectory, ledgerName), completedLedger);
    for (const stage of ['write-started', 'write-complete', 'verified-complete'] as const) {
      await writeFile(join(legacy, `result-${id}-${stage}.json`), JSON.stringify({ schemaVersion: 1, stage, value: { preparationId: id } }));
    }

    expect(await inspectFirmwareSafetyEvidence(legacy)).toEqual([]);
    expect((await migrateLegacyFirmwareState(target, [legacy])).status).toBe('imported');
    const migratedLedger = join(target, 'completed-ledger-v1', 'archive', '2026', ledgerName);
    expect(await readFile(migratedLedger, 'utf8')).toBe(completedLedger);
    expect(await readFile(join(legacy, 'completed-ledger-v1', 'archive', '2026', ledgerName), 'utf8')).toBe(completedLedger);
    for (const stage of ['write-started', 'write-complete', 'verified-complete'] as const) {
      expect(JSON.parse(await readFile(join(target, `result-${id}-${stage}.json`), 'utf8'))).toMatchObject({ stage, value: { preparationId: id } });
    }
    expect(await inspectFirmwareSafetyEvidence(target)).toEqual([]);
  });

  it('consumes a legacy baseline once, so an advanced target journal stays authoritative on launch two', async () => {
    const root = await temporary('flasher-two-launch-ready-');
    const target = join(root, 'target');
    const legacy = join(root, 'legacy');
    const id = 'a5ada7f3-fbe3-41bd-83ac-a07028bc55f6';
    await mkdir(legacy);
    const ready = JSON.stringify({ schemaVersion: 1, state: { phase: 'ready-to-flash', writeDisposition: 'not-started', preparation: { id } } });
    await writeFile(join(legacy, JOURNAL_FILENAME), ready);
    expect((await migrateLegacyFirmwareState(target, [legacy])).status).toBe('imported');

    const advanced = JSON.stringify({ schemaVersion: 1, state: { phase: 'awaiting-dfu', writeDisposition: 'not-started', preparation: { id } } });
    await writeFile(join(target, JOURNAL_FILENAME), advanced);
    expect((await migrateLegacyFirmwareState(target, [legacy])).status).toBe('already-current');
    expect(await readFile(join(target, JOURNAL_FILENAME), 'utf8')).toBe(advanced);
    expect(await fileExists(join(target, MIGRATION_CONFLICT_FILENAME))).toBe(false);

    await writeFile(join(legacy, JOURNAL_FILENAME), `${ready}\n`);
    expect((await migrateLegacyFirmwareState(target, [legacy])).status).toBe('conflict');
    expect(JSON.parse(await readFile(join(target, MIGRATION_CONFLICT_FILENAME), 'utf8')).reason).toMatch(/legacy safety evidence changed/i);
  });

  it('does not resurrect a consumed completed journal after the target archives it before launch two', async () => {
    const root = await temporary('flasher-two-launch-complete-');
    const target = join(root, 'target');
    const legacy = join(root, 'legacy');
    const id = 'a5ada7f3-fbe3-41bd-83ac-a07028bc55f6';
    const ledgerName = `device-407-preparation-${id}.json`;
    await mkdir(legacy);
    const completed = completedLedgerJson(id);
    await writeFile(join(legacy, JOURNAL_FILENAME), completed);
    expect((await migrateLegacyFirmwareState(target, [legacy])).status).toBe('imported');

    const ledgerDirectory = join(target, 'completed-ledger-v1');
    await mkdir(ledgerDirectory);
    await rename(join(target, JOURNAL_FILENAME), join(ledgerDirectory, ledgerName));
    expect((await migrateLegacyFirmwareState(target, [legacy])).status).toBe('already-current');
    expect(await fileExists(join(target, JOURNAL_FILENAME))).toBe(false);
    expect(await readFile(join(ledgerDirectory, ledgerName), 'utf8')).toBe(completed);
    expect(await fileExists(join(target, MIGRATION_CONFLICT_FILENAME))).toBe(false);
  });

  it('fails closed on symlinked reserved journals and write locks', async () => {
    const root = await temporary('flasher-symlink-reserved-');
    const target = join(root, 'target');
    const legacy = join(root, 'legacy');
    await mkdir(legacy);
    const outsideJournal = join(root, 'outside-journal.json');
    const outsideLock = join(root, 'outside-lock.json');
    await writeFile(outsideJournal, '{"state":"hidden"}');
    await writeFile(outsideLock, '{"owner":"hidden"}');
    await symlink(outsideJournal, join(legacy, JOURNAL_FILENAME));
    await symlink(outsideLock, join(legacy, 'firmware-write.lock'));

    expect((await migrateLegacyFirmwareState(target, [legacy])).status).toBe('conflict');
    expect(JSON.parse(await readFile(join(target, MIGRATION_CONFLICT_FILENAME), 'utf8')).reason).toMatch(/not a real regular file/i);
  });

  it('fails closed on a symlinked completed-ledger root', async () => {
    const root = await temporary('flasher-symlink-ledger-root-');
    const target = join(root, 'target');
    const legacy = join(root, 'legacy');
    const outsideLedger = join(root, 'outside-ledger');
    await Promise.all([mkdir(legacy), mkdir(outsideLedger)]);
    await symlink(outsideLedger, join(legacy, 'completed-ledger-v1'));

    expect((await migrateLegacyFirmwareState(target, [legacy])).status).toBe('conflict');
    expect(JSON.parse(await readFile(join(target, MIGRATION_CONFLICT_FILENAME), 'utf8')).reason).toMatch(/ledger path is not a real directory/i);
  });

  it('fails closed on symlinked JSON files and subdirectories inside the completed ledger', async () => {
    const root = await temporary('flasher-symlink-ledger-tree-');
    const target = join(root, 'target');
    const legacy = join(root, 'legacy');
    const ledger = join(legacy, 'completed-ledger-v1');
    const outsideFile = join(root, 'outside-ledger.json');
    const outsideDirectory = join(root, 'outside-archive');
    await Promise.all([mkdir(ledger, { recursive: true }), mkdir(outsideDirectory), writeFile(outsideFile, '{}')]);
    await symlink(outsideFile, join(ledger, 'device-407-preparation-a5ada7f3-fbe3-41bd-83ac-a07028bc55f6.json'));
    await symlink(outsideDirectory, join(ledger, 'archive'));

    expect((await migrateLegacyFirmwareState(target, [legacy])).status).toBe('conflict');
    expect(JSON.parse(await readFile(join(target, MIGRATION_CONFLICT_FILENAME), 'utf8')).reason).toMatch(/ledger contains a symbolic link/i);
  });

  it('rejects a symlinked consumed marker instead of suppressing legacy discovery', async () => {
    const root = await temporary('flasher-symlink-marker-');
    const target = join(root, 'target');
    const legacy = join(root, 'legacy');
    await Promise.all([mkdir(target), mkdir(legacy)]);
    const outsideMarker = join(root, 'outside-marker.json');
    await writeFile(outsideMarker, JSON.stringify({ schemaVersion: 1, checkedAt: new Date().toISOString(), status: 'none', sources: [], importedEvidence: [], consumedEvidence: [] }));
    await symlink(outsideMarker, join(target, MIGRATION_MARKER_FILENAME));
    await writeFile(join(legacy, JOURNAL_FILENAME), '{"schemaVersion":1,"state":{"phase":"available","writeDisposition":"not-started"}}');

    expect((await migrateLegacyFirmwareState(target, [legacy])).status).toBe('conflict');
    expect(JSON.parse(await readFile(join(target, MIGRATION_CONFLICT_FILENAME), 'utf8')).reason).toMatch(/marker is not a real regular file/i);
  });

  it('enumerates every directory that must be synced before committing a nested-ledger marker', async () => {
    const root = await temporary('flasher-sync-chain-');
    const target = join(root, 'target');
    const leaf = join(target, 'completed-ledger-v1', 'archive', '2026');
    expect(directoryChainToRoot(leaf, target)).toEqual([
      leaf,
      join(target, 'completed-ledger-v1', 'archive'),
      join(target, 'completed-ledger-v1'),
      target,
    ]);
    expect(() => directoryChainToRoot(root, target)).toThrow(/outside migration target/i);
  });
});

function completedLedgerJson(id: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    targetVersion: OEM_ZS407_FIRMWARE_RELEASE.version,
    writtenAt: '2026-07-14T12:04:00.000Z',
    state: {
      phase: 'completed',
      target: OEM_ZS407_FIRMWARE_RELEASE,
      updateAvailable: false,
      dfuUtility: { available: true, version: 'dfu-util 0.11' },
      dfuDevice: { detected: false, count: 0 },
      preparation: {
        id,
        preparedAt: '2026-07-14T12:00:00.000Z',
        batteryMillivolts: 4100,
        deviceId: 407,
        screenSha256: 'a'.repeat(64),
        selfTestPassed: true,
        selfTestProcedure: OEM_ZS407_SELF_TEST_PROCEDURE.id,
        configurationDisposition: 'new-device-unchanged',
        rfPortsDisconnected: true,
        onlyUsbDeviceConnected: true,
        usbContinuity: {
          cdcPath: '/dev/tty.usbmodem407',
          cdcSerialNumber: 'CDC407',
          vendorId: '0483',
          productId: '5740',
          deviceId: 407,
        },
      },
      writeDisposition: 'completed',
      writeStartedAt: '2026-07-14T12:01:00.000Z',
      writeCompletedAt: '2026-07-14T12:02:00.000Z',
      completedAt: '2026-07-14T12:03:00.000Z',
    },
  }, null, 2);
}

async function temporary(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function fileExists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
