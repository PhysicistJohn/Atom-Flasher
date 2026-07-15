import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMPLETED_LEDGER_DIRECTORY,
  FIRMWARE_EVIDENCE_LAYOUT_V1,
  FIRMWARE_EVIDENCE_LAYOUT_V2,
  JOURNAL_FILENAME,
  JOURNAL_V2_FILENAME,
  completedLedgerFilename,
  preflightFilename,
  resultAuditFilename,
} from '../src/core/persistence/evidence-layout.js';
import {
  EVIDENCE_V1_FIRMWARE_RELEASE,
  completedLedgerV1Schema,
  firmwareUpdateJournalV1Schema,
  journalLockV1Schema,
  migrationConflictV1Schema,
  migrationMarkerV1Schema,
  preflightRecordV1Schema,
  transactionAuditV1Schema,
  writeLockV1Schema,
} from '../src/core/persistence/evidence-schemas-v1.js';
import {
  firmwareTargetV2Sha256,
  firmwareUpdateJournalV2Schema,
} from '../src/core/persistence/evidence-schemas-v2.js';
import {
  FIRMWARE_EVIDENCE_RELEASE_REGISTRY,
  FIRMWARE_EVIDENCE_SCHEMA_REGISTRY,
  parseHistoricalCompletedLedger,
  requireEvidenceDefinitionForWriter,
} from '../src/core/persistence/evidence-registry.js';
import { MAX_DURABLE_FILE_BYTES, readStableRegularFile, writeExclusiveAtomic } from '../src/core/persistence/durable-files.js';
import { FirmwareTransactionStore } from '../src/core/persistence/firmware-transaction-store.js';

const PREPARATION_ID = 'a5ada7f3-fbe3-41bd-83ac-a07028bc55f6';
const OWNER_TOKEN = 'c42b1e0d-afb3-44e8-8f87-19a8bcf351f2';
const WRITTEN_AT = '2026-07-14T12:04:00.000Z';

describe('versioned durable firmware evidence', () => {
  it('keeps a historical completed ledger valid when a future active release policy is evaluated', () => {
    const historicalLedger = completedLedger();
    const futureActiveRelease = {
      ...EVIDENCE_V1_FIRMWARE_RELEASE,
      version: 'tinySA4_v1.4-225-gabcdef',
      revision: 'abcdef0',
      sourceCommit: 'abcdef0123456789abcdef0123456789abcdef01',
      sha256: 'b'.repeat(64),
    };

    expect(() => requireEvidenceDefinitionForWriter(futureActiveRelease.version)).toThrow(/allocate and register a new schema version/i);
    expect(parseHistoricalCompletedLedger(historicalLedger)).toMatchObject({
      schemaVersion: 1,
      targetVersion: EVIDENCE_V1_FIRMWARE_RELEASE.version,
      state: { phase: 'completed', preparation: { id: PREPARATION_ID } },
    });
    expect(FIRMWARE_EVIDENCE_RELEASE_REGISTRY[EVIDENCE_V1_FIRMWARE_RELEASE.version].release).toBe(EVIDENCE_V1_FIRMWARE_RELEASE);
    expect(Object.isFrozen(FIRMWARE_EVIDENCE_RELEASE_REGISTRY)).toBe(true);
    expect(FIRMWARE_EVIDENCE_SCHEMA_REGISTRY[2]).toEqual({ schemaVersion: 2, targetBinding: 'embedded-target-sha256' });
  });

  it('pins journal v1 to its historical target and does not admit a metadata reinterpretation', () => {
    const journal = activeJournal();
    expect(firmwareUpdateJournalV1Schema.safeParse(journal).success).toBe(true);
    expect(firmwareUpdateJournalV1Schema.safeParse({ ...journal, targetVersion: 'tinySA4_future' }).success).toBe(false);
    expect(firmwareUpdateJournalV1Schema.safeParse({
      ...journal,
      state: { ...journal.state, target: { ...journal.state.target, sha256: 'c'.repeat(64) } },
    }).success).toBe(false);
  });

  it('distinguishes an active journal from an immutable completed-ledger record', () => {
    expect(firmwareUpdateJournalV1Schema.safeParse(activeJournal()).success).toBe(true);
    expect(completedLedgerV1Schema.safeParse(activeJournal()).success).toBe(false);
    expect(completedLedgerV1Schema.safeParse(completedLedger()).success).toBe(true);
  });

  it('requires canonical DFU fingerprint, target-line fields, and usable internal-flash geometry', () => {
    const identity = dfuIdentity();
    expect(writeLockV1Schema.safeParse({
      schemaVersion: 1, ownerToken: OWNER_TOKEN, acquiredAt: WRITTEN_AT,
      purpose: 'firmware-write', preparationId: PREPARATION_ID, dfuIdentity: identity,
    }).success).toBe(true);
    const parse = (dfuIdentity: object) => writeLockV1Schema.safeParse({
      schemaVersion: 1, ownerToken: OWNER_TOKEN, acquiredAt: WRITTEN_AT,
      purpose: 'firmware-write', preparationId: PREPARATION_ID, dfuIdentity,
    }).success;
    expect(parse({ ...identity, fingerprint: '{}' })).toBe(false);
    expect(parse({ ...identity, targetLine: identity.targetLine.replace('serial="DFU407"', 'serial="OTHER"') })).toBe(false);
    expect(parse(rebuildDfuIdentity('@Internal Flash /0x08004000/128*002Kg'))).toBe(false);
    expect(parse(rebuildDfuIdentity('@Internal Flash /0x08000000/64*002Kg'))).toBe(false);
    expect(parse(rebuildDfuIdentity('@Internal Flash /0x08000000/128*002Ka'))).toBe(false);
  });

  it('versions and validates write locks separately from journal mutexes', () => {
    const common = { schemaVersion: 1, ownerToken: OWNER_TOKEN, acquiredAt: WRITTEN_AT } as const;
    expect(journalLockV1Schema.safeParse({ ...common, purpose: 'journal-mutation' }).success).toBe(true);
    expect(writeLockV1Schema.safeParse({
      ...common,
      purpose: 'firmware-write',
      preparationId: PREPARATION_ID,
      dfuIdentity: dfuIdentity(),
    }).success).toBe(true);
    expect(writeLockV1Schema.safeParse({ ...common, purpose: 'firmware-write' }).success).toBe(false);
  });

  it('validates preflight, result-audit, marker, and conflict envelopes independently', () => {
    const preflight = preflightRecord();
    expect(preflightRecordV1Schema.safeParse(preflight).success).toBe(true);
    expect(preflightRecordV1Schema.safeParse({ ...preflight, schemaVersion: 2 }).success).toBe(false);

    const audit = {
      schemaVersion: 1,
      stage: 'write-started',
      target: EVIDENCE_V1_FIRMWARE_RELEASE,
      value: { preparationId: PREPARATION_ID, writeStartedAt: WRITTEN_AT, dfuIdentity: dfuIdentity() },
    };
    expect(transactionAuditV1Schema.safeParse(audit).success).toBe(true);
    expect(transactionAuditV1Schema.safeParse({ ...audit, stage: 'download-verified' }).success).toBe(false);

    const reference = { path: '/legacy/result.json', relativePath: 'result.json', sha256: 'd'.repeat(64) };
    expect(migrationMarkerV1Schema.safeParse({
      schemaVersion: 1, checkedAt: WRITTEN_AT, status: 'imported', sources: ['/legacy/result.json'], importedEvidence: ['result.json'], consumedEvidence: [reference],
    }).success).toBe(true);
    expect(migrationConflictV1Schema.safeParse({ schemaVersion: 1, detectedAt: WRITTEN_AT, reason: 'conflict', evidence: [reference] }).success).toBe(true);
    expect(migrationConflictV1Schema.safeParse({ schemaVersion: 2, detectedAt: WRITTEN_AT, reason: 'conflict', evidence: [reference] }).success).toBe(false);
  });

  it('rejects internally inconsistent or chronologically impossible preflight evidence', () => {
    const valid = preflightRecord();
    expect(preflightRecordV1Schema.safeParse(valid).success).toBe(true);
    expect(preflightRecordV1Schema.safeParse({
      ...valid,
      preparation: { ...valid.preparation, usbContinuity: { ...valid.preparation.usbContinuity, deviceId: 999 } },
    }).success).toBe(false);
    expect(preflightRecordV1Schema.safeParse({ ...valid, telemetry: { ...valid.telemetry, batteryMillivolts: 4_200 } }).success).toBe(false);
    expect(preflightRecordV1Schema.safeParse({
      ...valid,
      preparation: { ...valid.preparation, usbContinuity: { ...valid.preparation.usbContinuity, cdcPath: '/dev/other' } },
    }).success).toBe(false);
    expect(preflightRecordV1Schema.safeParse({ ...valid, commands: valid.commands.filter((command) => command !== 'capture') }).success).toBe(false);
    expect(preflightRecordV1Schema.safeParse({ ...valid, infoLines: [] }).success).toBe(false);
    expect(preflightRecordV1Schema.safeParse({
      ...valid,
      artifact: { ...valid.artifact, verifiedAt: '2026-07-14T12:00:30.000Z' },
    }).success).toBe(false);
    expect(preflightRecordV1Schema.safeParse({
      ...valid,
      telemetry: { ...valid.telemetry, capturedAt: '2026-07-14T12:00:30.000Z' },
    }).success).toBe(false);
  });

  it('requires every proof field and ordered timestamp in a completed ledger', () => {
    const mutations: Array<(ledger: ReturnType<typeof completedLedger>) => void> = [
      (ledger) => { ledger.state.updateAvailable = true; },
      (ledger) => { Reflect.deleteProperty(ledger.state, 'current'); },
      (ledger) => { Reflect.deleteProperty(ledger.state, 'artifact'); },
      (ledger) => { Reflect.set(ledger.state, 'dfuUtility', { available: false }); },
      (ledger) => { Reflect.set(ledger.state, 'dfuDevice', { detected: false, count: 0 }); },
      (ledger) => { Reflect.deleteProperty(ledger.state, 'flashProgress'); },
      (ledger) => { Reflect.set(ledger.state, 'error', 'unexpected'); },
      (ledger) => { ledger.state.artifact!.verifiedAt = '2026-07-14T12:00:01.000Z'; },
      (ledger) => { ledger.state.preparation!.preparedAt = '2026-07-14T12:01:01.000Z'; },
      (ledger) => { ledger.state.writeStartedAt = '2026-07-14T12:02:01.000Z'; },
      (ledger) => { ledger.state.writeCompletedAt = '2026-07-14T12:03:01.000Z'; },
      (ledger) => { ledger.state.completedAt = '2026-07-14T12:04:01.000Z'; },
      (ledger) => { ledger.state.flashProgress!.updatedAt = '2026-07-14T12:03:01.000Z'; },
    ];
    expect(completedLedgerV1Schema.safeParse(completedLedger()).success).toBe(true);
    for (const mutate of mutations) {
      const ledger = structuredClone(completedLedger());
      mutate(ledger);
      expect(completedLedgerV1Schema.safeParse(ledger).success).toBe(false);
    }
  });

  it('accepts an idempotent durable write only when the existing bytes are equal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tinysa-durable-equality-'));
    const path = join(directory, 'evidence.json');
    try {
      await writeExclusiveAtomic(path, '{"proof":1}');
      await expect(writeExclusiveAtomic(path, '{"proof":1}')).resolves.toBeUndefined();
      await expect(writeExclusiveAtomic(path, '{"proof":2}')).rejects.toThrow(/evidence collision/i);
      expect(await readFile(path, 'utf8')).toBe('{"proof":1}');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not follow a final-component symlink swapped in after initial metadata inspection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tinysa-stable-read-'));
    try {
      const evidence = join(directory, 'evidence.json');
      const outside = join(directory, 'outside.json');
      await writeFile(evidence, '{"trusted":true}', { mode: 0o600 });
      await writeFile(outside, '{"attacker":true}', { mode: 0o600 });

      await expect(readStableRegularFile(evidence, 'test evidence', {
        afterInitialLstat: async () => {
          await rm(evidence);
          await symlink(outside, evidence);
        },
      })).rejects.toThrow();
      expect(await readFile(outside, 'utf8')).toBe('{"attacker":true}');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps stable reads bounded when a file grows after its opened size is checked', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tinysa-bounded-stable-read-'));
    try {
      const evidence = join(directory, 'evidence.json');
      await writeFile(evidence, '{}', { mode: 0o600 });

      await expect(readStableRegularFile(evidence, 'test evidence', {
        afterOpenedStat: async () => truncate(evidence, MAX_DURABLE_FILE_BYTES + 1),
      })).rejects.toThrow(/became longer while it was being read/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('tightens an owner-controlled legacy firmware root but rejects a previously writable root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'tinysa-root-permissions-'));
    const ownerControlled = join(parent, 'owner-controlled');
    const untrusted = join(parent, 'untrusted');
    try {
      await mkdir(ownerControlled, { mode: 0o755 });
      const compatible = await new FirmwareTransactionStore(ownerControlled).recover();
      expect(compatible).toEqual({ writeLockPresent: false });
      expect((await stat(ownerControlled)).mode & 0o777).toBe(0o700);

      await mkdir(untrusted, { mode: 0o777 });
      await chmod(untrusted, 0o777);
      const blocked = await new FirmwareTransactionStore(untrusted).recover();
      expect(blocked.state).toBeUndefined();
      expect(blocked.blockingReason).toMatch(/root is writable by another user or group/i);
      expect((await stat(untrusted)).mode & 0o777).toBe(0o777);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('fails closed on writable or multiply-linked reserved evidence', async () => {
    const writableRoot = await mkdtemp(join(tmpdir(), 'tinysa-writable-evidence-'));
    const linkedRoot = await mkdtemp(join(tmpdir(), 'tinysa-linked-evidence-'));
    try {
      const writableJournal = join(writableRoot, JOURNAL_V2_FILENAME);
      await writeFile(writableJournal, '{}', { mode: 0o600 });
      await chmod(writableJournal, 0o660);
      const writable = await new FirmwareTransactionStore(writableRoot).recover();
      expect(writable.state).toBeUndefined();
      expect(writable.blockingReason).toMatch(/writable by another user or group/i);

      const linkedJournal = join(linkedRoot, JOURNAL_V2_FILENAME);
      await writeFile(linkedJournal, '{}', { mode: 0o600 });
      await link(linkedJournal, join(linkedRoot, 'retained-alias.json'));
      const linked = await new FirmwareTransactionStore(linkedRoot).recover();
      expect(linked.state).toBeUndefined();
      expect(linked.blockingReason).toMatch(/exactly one filesystem link/i);
    } finally {
      await Promise.all([
        rm(writableRoot, { recursive: true, force: true }),
        rm(linkedRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it('keeps layout v1 names explicit and filename constructors bounded', () => {
    expect(FIRMWARE_EVIDENCE_LAYOUT_V1.completedLedgerDirectory).toBe(COMPLETED_LEDGER_DIRECTORY);
    expect(FIRMWARE_EVIDENCE_LAYOUT_V2).toMatchObject({
      journalFilename: JOURNAL_V2_FILENAME,
      completedLedgerDirectory: 'completed-ledger-v2',
    });
    expect(preflightFilename(PREPARATION_ID)).toBe(`preflight-${PREPARATION_ID}.json`);
    expect(resultAuditFilename(PREPARATION_ID, 'verified-complete')).toBe(`result-${PREPARATION_ID}-verified-complete.json`);
    expect(completedLedgerFilename(407, PREPARATION_ID)).toBe(`device-407-preparation-${PREPARATION_ID}.json`);
    expect(() => completedLedgerFilename(-1, PREPARATION_ID)).toThrow(/nonnegative/);
  });

  it.each([
    ['unsupported active journal', async (directory: string) => {
      await writeFile(join(directory, 'firmware-update-journal-v3.json'), '{"schemaVersion":3}');
    }],
    ['unsupported completed ledger', async (directory: string) => {
      await mkdir(join(directory, 'completed-ledger-v3'));
    }],
    ['unsupported migration evidence', async (directory: string) => {
      await writeFile(join(directory, 'legacy-migration-conflict-v2.json'), '{"schemaVersion":2}');
    }],
  ] as const)('fails closed for %s instead of treating it as absent', async (_label, arrange) => {
    const directory = await mkdtemp(join(tmpdir(), 'tinysa-unsupported-evidence-'));
    try {
      await arrange(directory);
      const recovered = await new FirmwareTransactionStore(directory).recover();
      expect(recovered.state).toBeUndefined();
      expect(recovered.blockingReason).toMatch(/unsupported.*version.*manual inspection/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects oversized reserved evidence before reading its declared bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tinysa-oversized-evidence-'));
    try {
      const path = join(directory, JOURNAL_V2_FILENAME);
      await writeFile(path, '{}');
      await truncate(path, MAX_DURABLE_FILE_BYTES + 1);

      const recovered = await new FirmwareTransactionStore(directory).recover();

      expect(recovered.state).toBeUndefined();
      expect(recovered.blockingReason).toMatch(/exceeds.*byte safety bound/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('migrates only an unprepared not-started v1 transaction so it can create v2 preflight evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tinysa-sticky-v1-'));
    try {
      const journal = {
        ...activeJournal(),
        state: {
          ...activeJournal().state,
          current: {
            version: 'tinySA4_v1.4-217-gc5dd31f' as const,
            revision: 'c5dd31f' as const,
            sourceCommit: 'c5dd31fd4679c15ba92ff46a6e258c1e3516ff0c' as const,
            qualification: 'supported-oem' as const,
          },
        },
      };
      await writeFile(join(directory, JOURNAL_FILENAME), JSON.stringify(journal, null, 2), { flag: 'wx' });
      const store = new FirmwareTransactionStore(directory);
      const recovered = await store.recover();
      expect(recovered).toMatchObject({
        writeLockPresent: false,
        state: { phase: 'available', target: { kind: 'oem' }, targetRelation: 'different-supported', writeIntent: 'update-oem' },
      });
      await expect(readFile(join(directory, JOURNAL_FILENAME)).then(() => true, () => false)).resolves.toBe(false);
      expect(JSON.parse(await readFile(join(directory, JOURNAL_V2_FILENAME), 'utf8'))).toMatchObject({
        schemaVersion: 2,
        targetId: 'oem-zs407-c979386',
        state: { target: { kind: 'oem' }, writeDisposition: 'not-started' },
      });
      await store.persist({ ...recovered.state!, phase: 'failed', error: 'operator stopped legacy transaction' });
      expect(JSON.parse(await readFile(join(directory, JOURNAL_V2_FILENAME), 'utf8'))).toMatchObject({
        schemaVersion: 2,
        targetId: 'oem-zs407-c979386',
        state: { phase: 'failed', target: { kind: 'oem' } },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps a prepared v1 journal and its immutable preflight byte-for-byte v1', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tinysa-prepared-v1-'));
    try {
      const preflight = preflightRecord();
      const journal = firmwareUpdateJournalV1Schema.parse({
        ...activeJournal(),
        state: {
          ...activeJournal().state,
          phase: 'awaiting-dfu',
          current: {
            version: 'tinySA4_v1.4-217-gc5dd31f',
            revision: 'c5dd31f',
            sourceCommit: 'c5dd31fd4679c15ba92ff46a6e258c1e3516ff0c',
            qualification: 'supported-oem',
          },
          artifact: preflight.artifact,
          preparation: preflight.preparation,
        },
      });
      const journalBody = JSON.stringify(journal, null, 2);
      const preflightBody = JSON.stringify(preflight, null, 2);
      await writeFile(join(directory, JOURNAL_FILENAME), journalBody, { flag: 'wx' });
      await writeFile(join(directory, preflightFilename(PREPARATION_ID)), preflightBody, { flag: 'wx' });

      const recovered = await new FirmwareTransactionStore(directory).recover();

      expect(recovered).toMatchObject({
        writeLockPresent: false,
        state: { phase: 'awaiting-dfu', preparation: { id: PREPARATION_ID }, target: { kind: 'oem' } },
      });
      expect(await readFile(join(directory, JOURNAL_FILENAME), 'utf8')).toBe(journalBody);
      expect(await readFile(join(directory, preflightFilename(PREPARATION_ID)), 'utf8')).toBe(preflightBody);
      await expect(readFile(join(directory, JOURNAL_V2_FILENAME)).then(() => true, () => false)).resolves.toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('finishes only an exact interrupted unprepared v1-to-v2 migration pair', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tinysa-interrupted-v1-migration-'));
    try {
      const legacy = {
        ...activeJournal(),
        state: {
          ...activeJournal().state,
          current: {
            version: 'tinySA4_v1.4-217-gc5dd31f' as const,
            revision: 'c5dd31f' as const,
            sourceCommit: 'c5dd31fd4679c15ba92ff46a6e258c1e3516ff0c' as const,
            qualification: 'supported-oem' as const,
          },
        },
      };
      const legacyBody = JSON.stringify(legacy, null, 2);
      await writeFile(join(directory, JOURNAL_FILENAME), legacyBody, { flag: 'wx' });
      await new FirmwareTransactionStore(directory).recover();
      await writeFile(join(directory, JOURNAL_FILENAME), legacyBody, { flag: 'wx' });

      const recovered = await new FirmwareTransactionStore(directory).recover();

      expect(recovered).toMatchObject({ state: { phase: 'available', target: { kind: 'oem' } }, writeLockPresent: false });
      await expect(readFile(join(directory, JOURNAL_FILENAME)).then(() => true, () => false)).resolves.toBe(false);
      expect(firmwareUpdateJournalV2Schema.safeParse(JSON.parse(await readFile(join(directory, JOURNAL_V2_FILENAME), 'utf8'))).success).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('blocks and preserves a divergent v1/v2 active-journal pair', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tinysa-divergent-v1-migration-'));
    try {
      const legacy = {
        ...activeJournal(),
        state: {
          ...activeJournal().state,
          current: {
            version: 'tinySA4_v1.4-217-gc5dd31f' as const,
            revision: 'c5dd31f' as const,
            sourceCommit: 'c5dd31fd4679c15ba92ff46a6e258c1e3516ff0c' as const,
            qualification: 'supported-oem' as const,
          },
        },
      };
      const legacyBody = JSON.stringify(legacy, null, 2);
      await writeFile(join(directory, JOURNAL_FILENAME), legacyBody, { flag: 'wx' });
      await new FirmwareTransactionStore(directory).recover();
      await writeFile(join(directory, JOURNAL_FILENAME), legacyBody, { flag: 'wx' });

      const v2Path = join(directory, JOURNAL_V2_FILENAME);
      const divergentV2 = firmwareUpdateJournalV2Schema.parse({
        ...JSON.parse(await readFile(v2Path, 'utf8')),
        state: {
          ...JSON.parse(await readFile(v2Path, 'utf8')).state,
          phase: 'failed',
          error: 'divergent active state',
        },
      });
      await writeFile(v2Path, JSON.stringify(divergentV2, null, 2));

      const recovered = await new FirmwareTransactionStore(directory).recover();

      expect(recovered).toMatchObject({
        writeLockPresent: false,
        blockingReason: expect.stringMatching(/both v1 and v2 active journals.*not an exact interrupted migration/i),
      });
      expect(recovered.state).toBeUndefined();
      expect(await readFile(join(directory, JOURNAL_FILENAME), 'utf8')).toBe(legacyBody);
      expect(JSON.parse(await readFile(v2Path, 'utf8'))).toEqual(divergentV2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('binds a self-contained v2 journal to the exact dynamic target hash', () => {
    const target = customTargetV2();
    const journal = {
      schemaVersion: 2 as const,
      targetId: target.targetId,
      targetSha256: firmwareTargetV2Sha256(target),
      writtenAt: WRITTEN_AT,
      state: {
        phase: 'available' as const,
        target,
        targetRelation: 'different-supported' as const,
        writeIntent: 'install-custom' as const,
        updateAvailable: true,
        current: {
          version: 'tinySA4_v1.4-217-gc5dd31f' as const,
          revision: 'c5dd31f' as const,
          qualification: 'supported-oem' as const,
        },
        dfuUtility: { available: false },
        dfuDevice: { detected: false, count: 0 },
        writeDisposition: 'not-started' as const,
      },
    };
    expect(firmwareUpdateJournalV2Schema.safeParse(journal).success).toBe(true);
    expect(firmwareUpdateJournalV2Schema.safeParse({
      ...journal,
      state: { ...journal.state, target: { ...target, qualificationEvidenceSha256: undefined } },
    }).success).toBe(false);
    expect(firmwareUpdateJournalV2Schema.safeParse({ ...journal, targetSha256: '0'.repeat(64) }).success).toBe(false);
    expect(firmwareUpdateJournalV2Schema.safeParse({
      ...journal,
      state: {
        ...journal.state,
        target: { ...target, buildProvenance: { ...target.buildProvenance, toolchain: 'forged' } },
      },
    }).success).toBe(false);
  });
});

function customTargetV2() {
  const digest = 'd'.repeat(64);
  return {
    kind: 'local-custom' as const,
    targetId: `custom-zs407-${digest}`,
    product: 'tinySA Ultra / Ultra+' as const,
    version: 'tinySA4_dev-225-g1111111',
    revision: '1111111',
    sourceCommit: `1111111${'1'.repeat(33)}`,
    sha256: digest,
    sizeBytes: 8 * 1024,
    manifestSha256: 'e'.repeat(64),
    hardwareQualification: 'qualified' as const,
    qualificationEvidenceSha256: 'f'.repeat(64),
    buildProvenance: {
      sourceRepository: 'PhysicistJohn/TinySA_Firmware' as const,
      chibiosCommit: '2'.repeat(40),
      sourceDateEpoch: 1_700_000_000,
      toolchain: 'arm-none-eabi-gcc 13.2.1',
      reproducibleCleanBuilds: true as const,
      simulationQualification: 'passed' as const,
    },
    transportIntegrity: 'local-manifest-sha256' as const,
  };
}

function activeJournal() {
  return {
    schemaVersion: 1 as const,
    targetVersion: EVIDENCE_V1_FIRMWARE_RELEASE.version,
    writtenAt: WRITTEN_AT,
    state: {
      phase: 'available' as const,
      target: EVIDENCE_V1_FIRMWARE_RELEASE,
      updateAvailable: true,
      dfuUtility: { available: false },
      dfuDevice: { detected: false, count: 0 },
      writeDisposition: 'not-started' as const,
    },
  };
}

function completedLedger() {
  return {
    schemaVersion: 1 as const,
    targetVersion: EVIDENCE_V1_FIRMWARE_RELEASE.version,
    writtenAt: WRITTEN_AT,
    state: {
      phase: 'completed' as const,
      target: EVIDENCE_V1_FIRMWARE_RELEASE,
      updateAvailable: false,
      current: {
        version: EVIDENCE_V1_FIRMWARE_RELEASE.version,
        revision: EVIDENCE_V1_FIRMWARE_RELEASE.revision,
        sourceCommit: EVIDENCE_V1_FIRMWARE_RELEASE.sourceCommit,
        qualification: 'supported-oem' as const,
      },
      artifact: {
        sizeBytes: EVIDENCE_V1_FIRMWARE_RELEASE.sizeBytes,
        sha256: EVIDENCE_V1_FIRMWARE_RELEASE.sha256,
        verifiedAt: '2026-07-14T11:59:00.000Z',
      },
      dfuUtility: { available: true, version: '0.11' },
      dfuDevice: { detected: true, count: 1, identity: dfuIdentity() },
      preparation: preparation(),
      writeDisposition: 'completed' as const,
      writeStartedAt: '2026-07-14T12:01:00.000Z',
      writeCompletedAt: '2026-07-14T12:02:00.000Z',
      flashProgress: {
        stage: 'complete' as const,
        percent: 100,
        stagePercent: 100,
        updatedAt: '2026-07-14T12:03:00.000Z',
      },
      completedAt: '2026-07-14T12:03:00.000Z',
    },
  };
}

function preparation() {
  return {
    id: PREPARATION_ID,
    preparedAt: '2026-07-14T12:00:00.000Z',
    batteryMillivolts: 4_100,
    deviceId: 407,
    screenSha256: 'a'.repeat(64),
    selfTestPassed: true as const,
    selfTestProcedure: 'tinySA4-zs407-cal-rf-v1' as const,
    configurationDisposition: 'new-device-unchanged' as const,
    rfPortsDisconnected: true as const,
    onlyUsbDeviceConnected: true as const,
    usbContinuity: {
      cdcPath: '/dev/tty.usbmodem407',
      cdcSerialNumber: 'CDC407',
      vendorId: '0483' as const,
      productId: '5740' as const,
      deviceId: 407,
    },
  };
}

function dfuIdentity() {
  return {
    path: '1-1', devnum: '5', serial: 'DFU407', alt: 0 as const,
    name: '@Internal Flash /0x08000000/128*002Kg',
    fingerprint: '{"path":"1-1","devnum":"5","serial":"DFU407","alt":0,"name":"@Internal Flash /0x08000000/128*002Kg"}',
    targetLine: 'Found DFU: [0483:df11] devnum=5, path="1-1", alt=0, name="@Internal Flash /0x08000000/128*002Kg", serial="DFU407"',
  };
}

function rebuildDfuIdentity(name: string) {
  const identity = dfuIdentity();
  return {
    ...identity,
    name,
    fingerprint: JSON.stringify({ path: identity.path, devnum: identity.devnum, serial: identity.serial, alt: identity.alt, name }),
    targetLine: `Found DFU: [0483:df11] devnum=${identity.devnum}, path="${identity.path}", alt=${identity.alt}, name="${name}", serial="${identity.serial}"`,
  };
}

function preflightRecord() {
  return {
    schemaVersion: 1 as const,
    target: EVIDENCE_V1_FIRMWARE_RELEASE,
    preparation: preparation(),
    identity: shippedIdentity(),
    firmwareVersionResponse: 'tinySA4_v1.4-217-gc5dd31f\r\nHW Version: V0.5.4 + ZS407',
    infoLines: ['tinySA ULTRA+ ZS407'],
    commands: ['version', 'info', 'help', 'mode', 'output', 'vbat', 'deviceid', 'capture'],
    telemetry: { batteryMillivolts: 4_100, deviceId: 407, capturedAt: '2026-07-14T11:59:30.000Z' },
    artifact: {
      sizeBytes: EVIDENCE_V1_FIRMWARE_RELEASE.sizeBytes,
      sha256: EVIDENCE_V1_FIRMWARE_RELEASE.sha256,
      verifiedAt: '2026-07-14T11:59:00.000Z',
    },
  };
}

function shippedIdentity() {
  return {
    model: 'tinySA Ultra+ ZS407' as const,
    hardwareVersion: 'V0.5.4 + ZS407',
    firmwareVersion: 'tinySA4_v1.4-217-gc5dd31f' as const,
    firmwareReportedRevision: 'c5dd31f' as const,
    firmwareSourceCommit: 'c5dd31fd4679c15ba92ff46a6e258c1e3516ff0c' as const,
    firmwareQualification: 'supported-oem' as const,
    port: {
      id: '/dev/tty.usbmodem407:CDC407:0483:5740', path: '/dev/tty.usbmodem407', serialNumber: 'CDC407',
      vendorId: '0483', productId: '5740', usbMatch: 'exact-zs407-cdc' as const,
    },
    usbIdentityVerified: true as const,
  };
}
