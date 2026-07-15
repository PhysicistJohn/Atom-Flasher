import { randomUUID } from 'node:crypto';
import { type Dirent } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  OEM_ZS407_FIRMWARE_RELEASE,
  OEM_ZS407_FIRMWARE_TARGET,
  firmwareUpdateStateSchema,
  type DfuIdentity,
  type FirmwareUpdateState,
} from '../contracts.js';
import {
  errorMessage,
  ensurePrivateFirmwareDirectory,
  hasCode,
  readStableRegularFile,
  sha256Bytes,
  syncDirectory,
  writeNewDurableFile,
} from './durable-files.js';
import {
  COMPLETED_LEDGER_DIRECTORY,
  COMPLETED_LEDGER_DIRECTORIES,
  COMPLETED_LEDGER_V2_DIRECTORY,
  JOURNAL_FILENAME,
  JOURNAL_V2_FILENAME,
  JOURNAL_LOCK_FILENAME,
  MIGRATION_CONFLICT_FILENAME,
  WRITE_LOCK_FILENAME,
  completedLedgerFilename,
  preflightFilename,
  resultAuditFilename,
  type TransactionAuditStage,
} from './evidence-layout.js';
import { inspectFirmwareSafetyEvidence } from './evidence-inspector.js';
import {
  inspectEvidenceLinkage,
  type AuditLinkageEvidence,
  type PreflightLinkageEvidence,
} from './evidence-linkage.js';
import {
  completedLedgerV1Schema,
  firmwareUpdateJournalV1Schema,
  firmwareUpdateStateV1Schema,
  journalLockV1Schema,
  preflightRecordV1Schema,
  transactionAuditV1Schema,
  writeLockV1Schema,
} from './evidence-schemas-v1.js';
import {
  completedLedgerV2Schema,
  firmwareTargetV2Sha256,
  firmwareUpdateJournalV2Schema,
  preflightRecordV2Schema,
  transactionAuditV2Schema,
  type PreflightRecordV2,
} from './evidence-schemas-v2.js';
import {
  parseHistoricalCompletedLedger,
  parseHistoricalFirmwareJournal,
  parseHistoricalPreflightRecord,
  parseHistoricalTransactionAudit,
  type HistoricalFirmwareJournal,
  type HistoricalPreflightRecord,
  type HistoricalTransactionAudit,
} from './evidence-registry.js';

type FirmwareJournalV1 = ReturnType<typeof firmwareUpdateJournalV1Schema.parse>;
export type FirmwarePreflightRecordV1 = ReturnType<typeof preflightRecordV1Schema.parse>;
export type FirmwarePreflightRecord = PreflightRecordV2;
type WriteLockV1 = ReturnType<typeof writeLockV1Schema.parse>;
type JournalLockV1 = ReturnType<typeof journalLockV1Schema.parse>;
type AuditValue<Stage extends TransactionAuditStage> = Extract<HistoricalTransactionAudit, { stage: Stage }>['value'];
type OwnedLock =
  | { path: string; record: WriteLockV1 }
  | { path: string; record: JournalLockV1 };

export interface FirmwareTransactionRecovery {
  state?: FirmwareUpdateState;
  blockingReason?: string;
  writeLockPresent: boolean;
}

/** Test-only scheduling seam. Production code never receives this hook. */
export interface FirmwareTransactionStoreTestHooks {
  beforeWriteLockAcquire?(preparationId: string): Promise<void>;
  afterWriteLockAcquire?(preparationId: string): Promise<void>;
  afterWriteAdmissionPersist?(preparationId: string): Promise<void>;
}

export interface FirmwareTransactionClockPort {
  now(): Date;
}

export interface FirmwareTransactionIdentityPort {
  randomUuid(): string;
}

export interface FirmwareTransactionStoreRuntime
  extends FirmwareTransactionClockPort, FirmwareTransactionIdentityPort {}

export interface FirmwareWriteSession {
  readonly preparationId: string;
  readonly dfuIdentity: DfuIdentity;
  admitWrite(state: FirmwareUpdateState): Promise<void>;
  persist(state: FirmwareUpdateState): Promise<void>;
  writeAudit<Stage extends TransactionAuditStage>(stage: Stage, value: AuditValue<Stage>): Promise<void>;
  archiveCompleted(state: FirmwareUpdateState): Promise<void>;
  releaseBeforeWrite(): Promise<void>;
  releaseAfterArchive(): Promise<void>;
}

/**
 * Owns all mutable and immutable firmware-transaction evidence.
 *
 * The coordinator may decide state transitions, but it cannot bypass the
 * generation check, durable mutex, write-lock ownership, preflight linkage,
 * append-only audit, or completed-ledger rules enforced here.
 */
export class FirmwareTransactionStore {
  #journalPath: string;
  #journalSchemaVersion: 1 | 2 = 2;
  readonly #journalV1Path: string;
  readonly #journalV2Path: string;
  readonly #writeLockPath: string;
  readonly #journalLockPath: string;
  readonly #runtime: FirmwareTransactionStoreRuntime;
  readonly #testHooks: FirmwareTransactionStoreTestHooks;
  #expectedJournalSha256: string | undefined;
  #ownedWriteLock: OwnedLock | undefined;
  #recovery: Promise<FirmwareTransactionRecovery> | undefined;
  #ownershipLost = false;
  #writeAdmitted = false;
  #writeAdmissionPersistAttempted = false;
  #completedSessionArchived = false;

  constructor(
    readonly directory: string,
    runtime: Partial<FirmwareTransactionStoreRuntime> = {},
    testHooks: FirmwareTransactionStoreTestHooks = {},
  ) {
    this.#journalV1Path = join(directory, JOURNAL_FILENAME);
    this.#journalV2Path = join(directory, JOURNAL_V2_FILENAME);
    this.#journalPath = this.#journalV2Path;
    this.#writeLockPath = join(directory, WRITE_LOCK_FILENAME);
    this.#journalLockPath = join(directory, JOURNAL_LOCK_FILENAME);
    this.#runtime = { ...DEFAULT_STORE_RUNTIME, ...runtime };
    this.#testHooks = testHooks;
  }

  get completedSessionArchived(): boolean { return this.#completedSessionArchived; }

  recover(): Promise<FirmwareTransactionRecovery> {
    this.#recovery ??= this.#recover();
    return this.#recovery;
  }

  async persist(state: FirmwareUpdateState): Promise<void> {
    if (this.#ownedWriteLock) {
      throw new Error('An owned firmware write boundary may be persisted only through its write-session capability');
    }
    await this.#withJournalMutation(() => this.#writeJournal(state));
  }

  async recordPreflightAndPersist(recordValue: FirmwarePreflightRecord, stateValue: FirmwareUpdateState): Promise<void> {
    const record = preflightRecordV2Schema.parse(recordValue);
    const state = firmwareUpdateStateSchema.parse(stateValue);
    if (this.#journalSchemaVersion !== 2 || this.#journalPath !== this.#journalV2Path) {
      throw new Error('A legacy v1 transaction cannot be retargeted or migrated to v2 evidence');
    }
    this.#assertPreflightMatchesState(record, state, 'new prepared journal');
    await this.#withJournalMutation(async () => {
      try {
        await writeNewDurableFile(
          join(this.directory, preflightFilename(record.preparation.id)),
          JSON.stringify(record, null, 2),
        );
      } catch (value) {
        throw new TransactionOwnershipError(`The immutable preflight record could not be claimed: ${errorMessage(value)}`, { cause: value });
      }
      await this.#writeJournal(state);
    });
  }

  async acquireWriteSession(preparationId: string, dfuIdentity: DfuIdentity): Promise<FirmwareWriteSession> {
    this.#assertOwnershipRetained();
    if (this.#ownedWriteLock) throw new Error('This transaction store already owns a firmware write lock');
    await this.#testHooks.beforeWriteLockAcquire?.(preparationId);
    await ensurePrivateFirmwareDirectory(this.directory);
    const record = writeLockV1Schema.parse({
      schemaVersion: 1,
      purpose: 'firmware-write',
      ownerToken: this.#randomUuid(),
      acquiredAt: this.#nowIso(),
      preparationId,
      dfuIdentity,
    });
    const lock = await this.#createOwnedLock(this.#writeLockPath, record);
    this.#ownedWriteLock = lock;
    this.#writeAdmitted = false;
    this.#writeAdmissionPersistAttempted = false;
    await this.#testHooks.afterWriteLockAcquire?.(preparationId);
    return Object.freeze({
      preparationId: record.preparationId,
      dfuIdentity: structuredClone(record.dfuIdentity),
      admitWrite: (state: FirmwareUpdateState) => this.#admitWrite(record, state),
      persist: (state: FirmwareUpdateState) => this.#persistSession(record, state),
      writeAudit: <Stage extends TransactionAuditStage>(stage: Stage, value: AuditValue<Stage>) => (
        this.#writeSessionAudit(record, stage, value)
      ),
      archiveCompleted: (state: FirmwareUpdateState) => this.#archiveSession(record, state),
      releaseBeforeWrite: () => this.#releaseBeforeWrite(record),
      releaseAfterArchive: () => this.#releaseAfterArchive(record),
    });
  }

  async writeLockExists(): Promise<boolean> {
    try { await lstat(this.#writeLockPath); return true; }
    catch (value) { if (isFileMissing(value)) return false; throw value; }
  }

  async archiveCompletedRecovery(state: FirmwareUpdateState): Promise<void> {
    const preparation = state.preparation;
    if (!preparation) throw new Error('Completed recovery journal has no preparation');
    await this.#archiveCompleted(state, preparation.deviceId, preparation.id);
  }

  async #admitWrite(session: WriteLockV1, nextStateValue: FirmwareUpdateState): Promise<void> {
    this.#assertSession(session);
    if (this.#writeAdmitted) throw new Error('The durable firmware write boundary was already admitted');
    const nextState = firmwareUpdateStateSchema.parse(nextStateValue);
    if (nextState.phase !== 'flashing'
      || nextState.writeDisposition !== 'started'
      || !nextState.writeStartedAt
      || nextState.preparation?.id !== session.preparationId
      || nextState.dfuDevice.identity?.fingerprint !== session.dfuIdentity.fingerprint) {
      throw new Error('Write admission requires the exact flashing state, preparation, and locked DFU identity');
    }
    await this.#withJournalMutation(async () => {
      const shared = await this.#readCurrentJournal('shared active journal');
      this.#assertSharedReadyJournal(shared, session);
      await this.#assertLinkedPreflight(shared);
      await this.#assertNoPriorCompletedEvidence(session.preparationId, shared.state.preparation!.deviceId);
      // From this point onward an exception cannot prove that the durable
      // started journal was not installed. Keep the owner lock until manual
      // inspection unless admission returns successfully.
      this.#writeAdmissionPersistAttempted = true;
      await this.#writeJournal(nextState);
      await this.#testHooks.afterWriteAdmissionPersist?.(session.preparationId);
    });
    this.#writeAdmitted = true;
  }

  async #persistSession(session: WriteLockV1, state: FirmwareUpdateState): Promise<void> {
    this.#assertSession(session);
    if (!this.#writeAdmitted) throw new Error('The firmware write session has not crossed its durable admission boundary');
    const nextState = firmwareUpdateStateSchema.parse(state);
    this.#assertAdmittedSessionState(session, nextState);
    await this.#withJournalMutation(() => this.#writeJournal(nextState));
  }

  async #writeSessionAudit<Stage extends TransactionAuditStage>(
    session: WriteLockV1,
    stage: Stage,
    value: AuditValue<Stage>,
  ): Promise<void> {
    this.#assertSession(session);
    if (!this.#writeAdmitted) throw new Error('A result audit cannot precede durable write admission');
    if (value.preparationId !== session.preparationId) {
      throw new Error('Result-audit preparation does not match the owned write session');
    }
    await this.#withJournalMutation(async () => {
      const shared = await this.#readCurrentJournal('active journal for result audit');
      if (shared.state.preparation?.id !== session.preparationId) {
        throw new TransactionOwnershipError('The active journal preparation changed before result-audit persistence');
      }
      const record = this.#journalSchemaVersion === 1
        ? transactionAuditV1Schema.parse({
          schemaVersion: 1,
          stage,
          target: OEM_ZS407_FIRMWARE_RELEASE,
          value: auditValueForV1(stage, value),
        })
        : transactionAuditV2Schema.parse({
          schemaVersion: 2,
          stage,
          target: historicalTarget(shared),
          targetSha256: firmwareTargetV2Sha256(historicalTarget(shared)),
          value,
        });
      try {
        await writeNewDurableFile(
          join(this.directory, resultAuditFilename(session.preparationId, stage)),
          JSON.stringify(record, null, 2),
        );
      } catch (cause) {
        throw new TransactionOwnershipError(`Immutable ${stage} result evidence already exists or could not be written: ${errorMessage(cause)}`, { cause });
      }
    });
  }

  async #archiveSession(session: WriteLockV1, state: FirmwareUpdateState): Promise<void> {
    this.#assertSession(session);
    if (!this.#writeAdmitted) throw new Error('An unadmitted firmware write session cannot be archived');
    await this.#archiveCompleted(state, state.preparation?.deviceId ?? -1, session.preparationId);
  }

  async #releaseBeforeWrite(session: WriteLockV1): Promise<void> {
    this.#assertSession(session);
    if (this.#writeAdmitted || this.#writeAdmissionPersistAttempted) {
      throw new Error('A firmware write lock whose admission persistence was attempted must remain for inspection unless completion is archived');
    }
    await this.#releaseOwnedWriteLock(session);
  }

  async #releaseAfterArchive(session: WriteLockV1): Promise<void> {
    this.#assertSession(session);
    if (!this.#completedSessionArchived) throw new Error('The firmware write lock cannot be released before immutable completion archival');
    await this.#releaseOwnedWriteLock(session);
  }

  async #recover(): Promise<FirmwareTransactionRecovery> {
    try {
      await ensurePrivateFirmwareDirectory(this.directory);
      if (await pathExists(join(this.directory, MIGRATION_CONFLICT_FILENAME))) {
        return blocked('Conflicting legacy firmware journals were found. Flashing is locked pending manual inspection; no journal was selected.');
      }
      if (await pathExists(this.#journalLockPath)) {
        return blocked('A durable firmware journal mutex already exists. Another process may be mutating safety evidence, or a prior mutation was interrupted; flashing is locked pending manual inspection.');
      }
      const initialHasV1 = await pathExists(this.#journalV1Path);
      const initialHasV2 = await pathExists(this.#journalV2Path);
      if (initialHasV1 && initialHasV2 && !await this.#finishInterruptedUnpreparedV1Migration()) {
        return blocked('Both v1 and v2 active journals exist and are not an exact interrupted migration of one unprepared, not-started v1 session. Flashing is locked pending manual inspection.');
      }
      const evidenceIssues = await inspectFirmwareSafetyEvidence(this.directory, { inspectArtifactCache: false });
      if (evidenceIssues.length) {
        return blocked(`Firmware transaction evidence is orphaned or inconsistent. Flashing is locked pending manual inspection: ${evidenceIssues.join('; ')}`);
      }

      let journal: HistoricalFirmwareJournal;
      try {
        const hasV1 = await pathExists(this.#journalV1Path);
        const hasV2 = await pathExists(this.#journalV2Path);
        if (hasV1 && hasV2) throw new Error('both v1 and v2 active journals exist');
        if (!hasV1 && !hasV2) {
          this.#journalPath = this.#journalV2Path;
          this.#journalSchemaVersion = 2;
          this.#expectedJournalSha256 = undefined;
          if (await this.writeLockExists()) {
            return blocked('An exclusive firmware write lock exists without a valid active journal. Flashing is locked pending manual inspection;', true);
          }
          return { writeLockPresent: false };
        }
        this.#journalPath = hasV1 ? this.#journalV1Path : this.#journalV2Path;
        const bytes = await readRegularFile(this.#journalPath, 'active firmware journal');
        this.#expectedJournalSha256 = sha256Bytes(bytes);
        journal = parseHistoricalFirmwareJournal(parseJson(bytes, 'active firmware journal'));
        this.#journalSchemaVersion = journal.schemaVersion;
      } catch (value) {
        if (isFileMissing(value)) {
          this.#expectedJournalSha256 = undefined;
          if (await this.writeLockExists()) {
            return blocked('An exclusive firmware write lock exists without a valid active journal. Flashing is locked pending manual inspection;', true);
          }
          return { writeLockPresent: false };
        }
        return blocked(`Firmware journal is invalid or unreadable. Flashing is locked pending manual inspection: ${errorMessage(value)}`);
      }

      if (await pathExists(this.#journalLockPath)) {
        return blocked('A durable firmware journal mutex appeared during state recovery. Flashing is locked pending manual inspection.');
      }
      const writeLockPresent = await this.writeLockExists();
      if (journal.schemaVersion === 1 && isMigratableUnpreparedV1Journal(journal) && !writeLockPresent) {
        journal = await this.#migrateUnpreparedV1Journal(journal);
      }
      return { state: activeStateFromHistoricalJournal(journal), writeLockPresent };
    } catch (value) {
      return blocked(`Firmware safety evidence could not be inspected. Flashing is locked pending manual inspection: ${errorMessage(value)}`);
    }
  }

  /**
   * V1 cannot represent dynamic target-bound preflight evidence. Only an
   * unprepared transaction with no write attempt may move to v2; prepared or
   * write-bearing v1 histories remain byte-for-byte v1 for their full life.
   */
  async #migrateUnpreparedV1Journal(journal: FirmwareJournalV1): Promise<HistoricalFirmwareJournal> {
    if (!isMigratableUnpreparedV1Journal(journal)) throw new Error('Only an unprepared, not-started v1 journal can migrate to v2');
    const state = activeStateFromHistoricalJournal(journal);
    const migrated = firmwareUpdateJournalV2Schema.parse({
      schemaVersion: 2,
      targetId: state.target.targetId,
      targetSha256: firmwareTargetV2Sha256(state.target),
      writtenAt: this.#nowIso(),
      state,
    });
    await this.#withJournalMutation(async () => {
      try {
        await writeNewDurableFile(this.#journalV2Path, JSON.stringify(migrated, null, 2));
        const installedBytes = await readRegularFile(this.#journalV2Path, 'migrated v2 active journal');
        const installed = parseHistoricalFirmwareJournal(parseJson(installedBytes, 'migrated v2 active journal'));
        if (installed.schemaVersion !== 2 || !isExactUnpreparedV1Migration(journal, installed)) {
          throw new Error('Installed v2 journal does not exactly represent the unprepared v1 session');
        }
        await rm(this.#journalV1Path);
        await syncDirectory(this.directory);
        this.#journalPath = this.#journalV2Path;
        this.#journalSchemaVersion = 2;
        this.#expectedJournalSha256 = sha256Bytes(installedBytes);
      } catch (value) {
        throw new TransactionOwnershipError(`Unprepared v1 journal migration did not complete safely: ${errorMessage(value)}`, { cause: value });
      }
    });
    return migrated;
  }

  /** Completes only the exact create-v2-before-retire-v1 crash state. */
  async #finishInterruptedUnpreparedV1Migration(): Promise<boolean> {
    if (await this.writeLockExists()) return false;
    let pair = await readSafeUnpreparedV1MigrationPair(this.#journalV1Path, this.#journalV2Path);
    if (!pair) return false;
    await ensurePrivateFirmwareDirectory(this.directory);
    const record = journalLockV1Schema.parse({
      schemaVersion: 1,
      purpose: 'journal-mutation',
      ownerToken: this.#randomUuid(),
      acquiredAt: this.#nowIso(),
    });
    const lock = await this.#createOwnedLock(this.#journalLockPath, record);
    try {
      pair = await readSafeUnpreparedV1MigrationPair(this.#journalV1Path, this.#journalV2Path);
      if (!pair || await this.writeLockExists()) {
        throw new TransactionOwnershipError('The interrupted v1-to-v2 migration pair changed before retirement');
      }
      await rm(this.#journalV1Path);
      await syncDirectory(this.directory);
    } finally {
      await this.#releaseOwnedLock(lock);
    }
    return true;
  }

  async #withJournalMutation<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertOwnershipRetained();
    await ensurePrivateFirmwareDirectory(this.directory);
    const record = journalLockV1Schema.parse({
      schemaVersion: 1,
      purpose: 'journal-mutation',
      ownerToken: this.#randomUuid(),
      acquiredAt: this.#nowIso(),
    });
    const lock = await this.#createOwnedLock(this.#journalLockPath, record);
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      await this.#assertWriteBoundary();
      await this.#assertJournalGeneration();
      outcome = { ok: true, value: await operation() };
    } catch (value) {
      if (value instanceof TransactionOwnershipError) this.#ownershipLost = true;
      outcome = { ok: false, error: value };
    }
    try { await this.#releaseOwnedLock(lock); }
    catch (value) {
      this.#ownershipLost = true;
      const operationContext = outcome.ok ? '' : ` The protected operation also failed: ${errorMessage(outcome.error)}.`;
      throw new TransactionOwnershipError(`The durable journal mutex could not be safely released.${operationContext} ${errorMessage(value)}`, { cause: value });
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  async #writeJournal(stateValue: FirmwareUpdateState): Promise<void> {
    const state = firmwareUpdateStateSchema.parse(stateValue);
    const journal: HistoricalFirmwareJournal = this.#journalSchemaVersion === 1
      ? firmwareUpdateJournalV1Schema.parse({
        schemaVersion: 1,
        targetVersion: OEM_ZS407_FIRMWARE_RELEASE.version,
        writtenAt: this.#nowIso(),
        state: stateForV1Evidence(state),
      })
      : firmwareUpdateJournalV2Schema.parse({
        schemaVersion: 2,
        targetId: state.target.targetId,
        targetSha256: firmwareTargetV2Sha256(state.target),
        writtenAt: this.#nowIso(),
        state,
      });
    const body = JSON.stringify(journal, null, 2);
    const bytes = new TextEncoder().encode(body);
    const temporaryPath = `${this.#journalPath}.${this.#randomUuid()}.part`;
    let installed = false;
    try {
      const handle = await open(temporaryPath, 'wx', 0o600);
      try { await handle.writeFile(body, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      if (this.#expectedJournalSha256 === undefined) {
        try { await link(temporaryPath, this.#journalPath); }
        catch (value) {
          if (hasCode(value, 'EEXIST')) throw new TransactionOwnershipError('An unexpected active journal appeared before initial transaction persistence', { cause: value });
          throw value;
        }
        installed = true;
        // Persist the create-once journal name before retiring its staged
        // sibling. A crash may leave the .part link, but cannot leave us
        // relying on an unsynced sole link for the active journal.
        await syncDirectory(this.directory);
        await rm(temporaryPath);
      } else {
        await rename(temporaryPath, this.#journalPath);
        installed = true;
      }
      await syncDirectory(this.directory);
      this.#expectedJournalSha256 = sha256Bytes(bytes);
    } catch (value) {
      if (installed) {
        this.#ownershipLost = true;
        throw new TransactionOwnershipError(`The active journal was installed but its directory durability is uncertain: ${errorMessage(value)}`, { cause: value });
      }
      try { await rm(temporaryPath, { force: true }); }
      catch (cleanupFailure) {
        this.#ownershipLost = true;
        throw new TransactionOwnershipError(`${errorMessage(value)}. Journal temporary cleanup also failed: ${errorMessage(cleanupFailure)}`, { cause: value });
      }
      throw value;
    }
  }

  async #archiveCompleted(stateValue: FirmwareUpdateState, deviceId: number, preparationId: string): Promise<void> {
    const state = firmwareUpdateStateSchema.parse(stateValue);
    if (state.phase !== 'completed'
      || state.writeDisposition !== 'completed'
      || state.preparation?.id !== preparationId
      || state.preparation.deviceId !== deviceId) {
      throw new Error('Only the exact verified completed session can enter the immutable completed ledger');
    }
    await this.#withJournalMutation(async () => {
      const shared = await this.#readCurrentJournal('completed active journal');
      const canonicalState = this.#journalSchemaVersion === 1
        ? stateForV1Evidence(state)
        : firmwareUpdateStateSchema.parse(JSON.parse(JSON.stringify(state)));
      if (!isDeepStrictEqual(shared.state, canonicalState)) {
        throw new TransactionOwnershipError('The completed in-memory state does not match the active journal selected for archival');
      }
      try {
        if (shared.schemaVersion === 1) completedLedgerV1Schema.parse(shared);
        else completedLedgerV2Schema.parse(shared);
      }
      catch (value) {
        throw new TransactionOwnershipError(`The active journal is not valid immutable completion evidence: ${errorMessage(value)}`, { cause: value });
      }
      await this.#assertCompletedEvidenceChain(shared);
      for (const directory of COMPLETED_LEDGER_DIRECTORIES) {
        await this.#assertPreparationAbsentFromLedgerTree(join(this.directory, directory), preparationId, deviceId);
      }
      const ledgerDirectory = join(
        this.directory,
        this.#journalSchemaVersion === 1 ? COMPLETED_LEDGER_DIRECTORY : COMPLETED_LEDGER_V2_DIRECTORY,
      );
      await mkdir(ledgerDirectory, { recursive: true, mode: 0o700 });
      const destination = join(ledgerDirectory, completedLedgerFilename(deviceId, preparationId));
      try { await link(this.#journalPath, destination); }
      catch (value) {
        if (hasCode(value, 'EEXIST')) throw new TransactionOwnershipError('A completed ledger entry already exists for this preparation; the active journal was not deleted or replaced', { cause: value });
        if (isFileMissing(value)) throw new TransactionOwnershipError('Verified completed session has no active journal to archive', { cause: value });
        throw value;
      }
      try {
        const destinationHash = sha256Bytes(await readRegularFile(destination, 'new completed ledger', true));
        if (!this.#expectedJournalSha256 || destinationHash !== this.#expectedJournalSha256) {
          throw new TransactionOwnershipError('The new completed ledger does not match the expected active journal generation');
        }
        await syncDirectory(ledgerDirectory);
        this.#completedSessionArchived = true;
        await rm(this.#journalPath);
        this.#expectedJournalSha256 = undefined;
        await syncDirectory(this.directory);
      } catch (value) {
        this.#ownershipLost = true;
        throw new TransactionOwnershipError(`Completion archival was installed but active-journal retirement is uncertain: ${errorMessage(value)}`, { cause: value });
      }
    });
  }

  async #assertWriteBoundary(): Promise<void> {
    let record: WriteLockV1;
    try { record = await readSchemaFile(this.#writeLockPath, 'firmware write lock', writeLockV1Schema.parse); }
    catch (value) {
      if (isFileMissing(value)) {
        if (this.#ownedWriteLock) throw new TransactionOwnershipError('The locally owned firmware write lock disappeared');
        return;
      }
      throw new TransactionOwnershipError(`The shared firmware write lock is invalid or unreadable: ${errorMessage(value)}`, { cause: value });
    }
    if (!this.#ownedWriteLock
      || this.#ownedWriteLock.record.purpose !== 'firmware-write'
      || !isDeepStrictEqual(record, this.#ownedWriteLock.record)) {
      throw new TransactionOwnershipError('Another process owns or changed the shared firmware write boundary');
    }
  }

  async #assertJournalGeneration(): Promise<void> {
    const alternatePath = this.#journalPath === this.#journalV1Path ? this.#journalV2Path : this.#journalV1Path;
    if (await pathExists(alternatePath)) {
      throw new TransactionOwnershipError('A second active journal generation appeared after this process loaded state');
    }
    let bytes: Uint8Array;
    try { bytes = await readRegularFile(this.#journalPath, 'active firmware journal'); }
    catch (value) {
      if (isFileMissing(value) && this.#expectedJournalSha256 === undefined) return;
      if (isFileMissing(value)) throw new TransactionOwnershipError('The expected active journal was removed or archived by another session', { cause: value });
      throw new TransactionOwnershipError(`The active journal cannot be read for generation verification: ${errorMessage(value)}`, { cause: value });
    }
    const actual = sha256Bytes(bytes);
    if (this.#expectedJournalSha256 === undefined) throw new TransactionOwnershipError('An unexpected active journal appeared after this process loaded state');
    if (actual !== this.#expectedJournalSha256) throw new TransactionOwnershipError('The active journal generation changed after this process loaded state');
  }

  async #assertLinkedPreflight(journal: HistoricalFirmwareJournal): Promise<void> {
    await this.#readLinkedPreflight(journal);
  }

  async #readLinkedPreflight(journal: HistoricalFirmwareJournal): Promise<PreflightLinkageEvidence> {
    const preparation = journal.state.preparation;
    if (!preparation) throw new TransactionOwnershipError('The ready journal has no preparation to link to immutable preflight evidence');
    const path = join(this.directory, preflightFilename(preparation.id));
    try {
      const bytes = await readRegularFile(path, 'linked preflight record');
      const record = parseHistoricalPreflightRecord(parseJson(bytes, 'linked preflight record'));
      this.#assertPreflightMatchesState(record, activeStateFromHistoricalJournal(journal), 'shared transaction journal');
      if (record.schemaVersion !== journal.schemaVersion) {
        throw new Error('preflight and journal schema versions differ');
      }
      return { path, sha256: sha256Bytes(bytes), record };
    } catch (value) {
      throw new TransactionOwnershipError(`The linked preflight record is missing, invalid, or unreadable: ${errorMessage(value)}`, { cause: value });
    }
  }

  async #assertCompletedEvidenceChain(journal: HistoricalFirmwareJournal): Promise<void> {
    const preparation = journal.state.preparation;
    if (!preparation) throw new TransactionOwnershipError('Completed evidence has no preparation identity');
    const preflight = await this.#readLinkedPreflight(journal);
    const audits: AuditLinkageEvidence[] = [];
    for (const stage of ['write-started', 'write-complete', 'verified-complete'] as const) {
      const path = join(this.directory, resultAuditFilename(preparation.id, stage));
      try {
        const bytes = await readRegularFile(path, `${stage} result audit`);
        const record = parseHistoricalTransactionAudit(parseJson(bytes, `${stage} result audit`));
        if (record.schemaVersion !== journal.schemaVersion) throw new Error('audit and journal schema versions differ');
        audits.push({ path, sha256: sha256Bytes(bytes), record });
      } catch (value) {
        throw new TransactionOwnershipError(`The completed transaction has missing or invalid ${stage} evidence: ${errorMessage(value)}`, { cause: value });
      }
    }
    const writeLock = this.#ownedWriteLock?.record.purpose === 'firmware-write'
      ? { path: this.#ownedWriteLock.path, lock: this.#ownedWriteLock.record }
      : undefined;
    const issues = inspectEvidenceLinkage({
      active: {
        kind: 'active journal',
        path: this.#journalPath,
        sha256: this.#expectedJournalSha256 ?? '',
        journal,
      },
      ledgers: [],
      preflights: [preflight],
      audits,
      writeLock,
    });
    if (issues.length) {
      throw new TransactionOwnershipError(`Completed transaction evidence is not internally linked: ${issues.join('; ')}`);
    }
  }

  #assertPreflightMatchesState(record: HistoricalPreflightRecord, state: FirmwareUpdateState, label: string): void {
    const preparation = state.preparation;
    const evidenceArtifact = record.schemaVersion === 1 && state.artifact
      ? artifactForV1Evidence(state.artifact)
      : state.artifact;
    const evidenceTarget = record.schemaVersion === 1 ? OEM_ZS407_FIRMWARE_RELEASE : state.target;
    const expectedV2Intent = record.schemaVersion === 2
      ? record.target.kind === 'local-custom' ? 'install-custom'
        : record.identity.firmwareQualification === 'custom-unqualified' ? 'restore-oem' : 'update-oem'
      : undefined;
    if (!preparation
      || !state.artifact
      || !isDeepStrictEqual(record.preparation, preparation)
      || !isDeepStrictEqual(record.artifact, evidenceArtifact)
      || !isDeepStrictEqual(record.target, evidenceTarget)
      || (record.schemaVersion === 2 && record.targetSha256 !== firmwareTargetV2Sha256(state.target))
      || (record.schemaVersion === 2 && state.writeIntent !== expectedV2Intent)
      || record.telemetry.deviceId !== preparation.deviceId
      || record.telemetry.batteryMillivolts !== preparation.batteryMillivolts
      || record.identity.port.path !== preparation.usbContinuity.cdcPath
      || record.identity.port.serialNumber !== preparation.usbContinuity.cdcSerialNumber
      || record.identity.port.vendorId?.toLowerCase() !== preparation.usbContinuity.vendorId
      || record.identity.port.productId?.toLowerCase() !== preparation.usbContinuity.productId) {
      throw new TransactionOwnershipError(`Immutable preflight evidence does not match the ${label}`);
    }
  }

  #assertSharedReadyJournal(shared: HistoricalFirmwareJournal, session: WriteLockV1): void {
    if (shared.state.phase !== 'ready-to-flash'
      || shared.state.writeDisposition !== 'not-started'
      || shared.state.preparation?.id !== session.preparationId
      || shared.state.dfuDevice.identity?.fingerprint !== session.dfuIdentity.fingerprint
      || !isDeepStrictEqual(shared.state.dfuDevice.identity, session.dfuIdentity)
      || !shared.state.dfuDevice.detected
      || shared.state.dfuDevice.count !== 1) {
      throw new TransactionOwnershipError('The shared active journal no longer supports this exact ready preparation and DFU identity');
    }
  }

  #assertAdmittedSessionState(session: WriteLockV1, state: FirmwareUpdateState): void {
    if (state.preparation?.id !== session.preparationId
      || !state.dfuDevice.detected
      || state.dfuDevice.count !== 1
      || !isDeepStrictEqual(state.dfuDevice.identity, session.dfuIdentity)
      || (state.writeDisposition !== 'started' && state.writeDisposition !== 'completed')
      || !state.writeStartedAt) {
      throw new TransactionOwnershipError('Persisted state does not match the admitted firmware write session capability');
    }
  }

  async #assertNoPriorCompletedEvidence(preparationId: string, deviceId: number): Promise<void> {
    for (const directory of COMPLETED_LEDGER_DIRECTORIES) {
      const ledgerDirectory = join(this.directory, directory);
      if (await pathExists(join(ledgerDirectory, completedLedgerFilename(deviceId, preparationId)))) {
        throw new TransactionOwnershipError('This exact device preparation already has completed-ledger evidence');
      }
      await this.#assertPreparationAbsentFromLedgerTree(ledgerDirectory, preparationId, deviceId);
    }
    let entries: string[] = [];
    try { entries = await readdir(this.directory); }
    catch (value) { if (!isFileMissing(value)) throw value; }
    if (entries.some((name) => name.startsWith(`result-${preparationId}-`) && name.endsWith('.json'))) {
      throw new TransactionOwnershipError('This preparation already has write-attempt result evidence');
    }
  }

  async #assertPreparationAbsentFromLedgerTree(directory: string, preparationId: string, deviceId: number): Promise<void> {
    let entries: Dirent[];
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (value) { if (isFileMissing(value)) return; throw value; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new TransactionOwnershipError(`Completed ledger contains a symbolic link at ${path}`);
      if (entry.isDirectory()) { await this.#assertPreparationAbsentFromLedgerTree(path, preparationId, deviceId); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      let ledger: ReturnType<typeof parseHistoricalCompletedLedger>;
      try { ledger = parseHistoricalCompletedLedger(parseJson(await readRegularFile(path, 'completed ledger'), 'completed ledger')); }
      catch (value) { throw new TransactionOwnershipError(`Completed ledger entry is invalid at ${path}: ${errorMessage(value)}`, { cause: value }); }
      if (ledger.state.phase !== 'completed' || ledger.state.writeDisposition !== 'completed' || !ledger.state.preparation) {
        throw new TransactionOwnershipError(`Completed ledger entry is not a verified transaction at ${path}`);
      }
      if (ledger.state.preparation.id === preparationId) {
        throw new TransactionOwnershipError(`This preparation already appears in completed ledger ${path}`);
      }
      const active = await this.#readCurrentJournal('active journal for completed-ledger uniqueness');
      if (historicalTargetId(ledger) === historicalTargetId(active)
        && ledger.state.preparation.deviceId === deviceId) {
        throw new TransactionOwnershipError(`Device ${deviceId} already has completed-ledger evidence for target ${historicalTargetId(ledger)} at ${path}`);
      }
    }
  }

  async #readCurrentJournal(label: string): Promise<HistoricalFirmwareJournal> {
    try {
      const journal = parseHistoricalFirmwareJournal(parseJson(await readRegularFile(this.#journalPath, label), label));
      if (journal.schemaVersion !== this.#journalSchemaVersion) throw new Error('active journal schema changed');
      return journal;
    } catch (value) {
      throw new TransactionOwnershipError(`The ${label} is missing, invalid, completed, or archived: ${errorMessage(value)}`, { cause: value });
    }
  }

  async #createOwnedLock<T extends WriteLockV1 | JournalLockV1>(path: string, record: T): Promise<{ path: string; record: T }> {
    let handle;
    try { handle = await open(path, 'wx', 0o600); }
    catch (value) {
      if (hasCode(value, 'EEXIST')) {
        const label = record.purpose === 'firmware-write' ? 'firmware write lock' : 'firmware journal mutex';
        throw new TransactionOwnershipError(`An exclusive ${label} already exists; this process will not mutate shared safety evidence`, { cause: value });
      }
      throw value;
    }
    try {
      await handle.writeFile(JSON.stringify(record, null, 2), 'utf8');
      await handle.sync();
      await handle.close();
      await syncDirectory(this.directory);
      return { path, record };
    } catch (value) {
      try { await handle.close(); } catch { /* Retain ambiguous lock evidence. */ }
      throw value;
    }
  }

  async #releaseOwnedLock(lock: OwnedLock): Promise<void> {
    let actual: WriteLockV1 | JournalLockV1;
    try {
      actual = lock.record.purpose === 'firmware-write'
        ? await readSchemaFile(lock.path, 'owned firmware-write lock', writeLockV1Schema.parse)
        : await readSchemaFile(lock.path, 'owned journal-mutation lock', journalLockV1Schema.parse);
    }
    catch (value) {
      throw new TransactionOwnershipError(`Owned ${lock.record.purpose} lock became unreadable before release: ${errorMessage(value)}`, { cause: value });
    }
    if (!isDeepStrictEqual(actual, lock.record)) {
      throw new TransactionOwnershipError(`Owned ${lock.record.purpose} lock record changed; the current path was not removed`);
    }
    await rm(lock.path);
    await syncDirectory(this.directory);
  }

  async #releaseOwnedWriteLock(session: WriteLockV1): Promise<void> {
    this.#assertSession(session);
    const lock = this.#ownedWriteLock!;
    await this.#releaseOwnedLock(lock);
    this.#ownedWriteLock = undefined;
  }

  #assertSession(session: WriteLockV1): void {
    if (!this.#ownedWriteLock
      || this.#ownedWriteLock.record.purpose !== 'firmware-write'
      || !isDeepStrictEqual(this.#ownedWriteLock.record, session)) {
      throw new TransactionOwnershipError('The firmware write session is not owned by this transaction store');
    }
  }

  #assertOwnershipRetained(): void {
    if (this.#ownershipLost) {
      throw new TransactionOwnershipError('This process no longer owns current shared firmware transaction evidence and cannot mutate it');
    }
  }

  #nowIso(): string {
    const value = this.#runtime.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error('Firmware transaction-store clock returned an invalid Date');
    }
    return value.toISOString();
  }

  #randomUuid(): string {
    const value = this.#runtime.randomUuid();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new Error('Firmware transaction-store UUID source returned an invalid UUID');
    }
    return value;
  }
}

export class TransactionOwnershipError extends Error {
  override readonly name = 'TransactionOwnershipError';
}

async function readSchemaFile<T>(path: string, label: string, parse: (value: unknown) => T): Promise<T> {
  return parse(parseJson(await readRegularFile(path, label), label));
}

async function readRegularFile(path: string, label: string, allowMultipleLinks = false): Promise<Uint8Array> {
  return readStableRegularFile(path, label, { allowMultipleLinks });
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (value) { throw new Error(`${label} is not valid UTF-8 JSON`, { cause: value }); }
}

function blocked(blockingReason: string, writeLockPresent = false): FirmwareTransactionRecovery {
  return { blockingReason, writeLockPresent };
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (value) { if (isFileMissing(value)) return false; throw value; }
}

function isFileMissing(value: unknown): boolean { return hasCode(value, 'ENOENT'); }

const DEFAULT_STORE_RUNTIME: FirmwareTransactionStoreRuntime = {
  now: () => new Date(),
  randomUuid: () => randomUUID(),
};

function historicalTarget(journal: HistoricalFirmwareJournal) {
  return journal.schemaVersion === 1 ? OEM_ZS407_FIRMWARE_TARGET : journal.state.target;
}

function historicalTargetId(journal: HistoricalFirmwareJournal): string {
  return journal.schemaVersion === 1 ? OEM_ZS407_FIRMWARE_TARGET.targetId : journal.targetId;
}

function artifactForV1Evidence(artifact: NonNullable<FirmwareUpdateState['artifact']>) {
  return {
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    verifiedAt: artifact.verifiedAt,
  };
}

function stateForV1Evidence(stateValue: FirmwareUpdateState): FirmwareJournalV1['state'] {
  const state = firmwareUpdateStateSchema.parse(stateValue);
  if (state.target.kind !== 'oem') throw new Error('Legacy v1 evidence cannot represent a custom firmware target');
  const compatible = { ...state };
  Reflect.deleteProperty(compatible, 'targetRelation');
  Reflect.deleteProperty(compatible, 'writeIntent');
  return firmwareUpdateStateV1Schema.parse({
    ...compatible,
    target: OEM_ZS407_FIRMWARE_RELEASE,
    ...(state.artifact ? { artifact: artifactForV1Evidence(state.artifact) } : {}),
  });
}

function activeStateFromHistoricalJournal(journal: HistoricalFirmwareJournal): FirmwareUpdateState {
  if (journal.schemaVersion === 2) return firmwareUpdateStateSchema.parse(journal.state);
  const legacy = journal.state;
  const target = OEM_ZS407_FIRMWARE_TARGET;
  const targetMatchesCurrent = Boolean(legacy.current
    && legacy.current.version === target.version
    && legacy.current.revision === target.revision
    && legacy.current.qualification === 'supported-oem');
  const targetRelation = !legacy.current ? 'unknown' as const
    : targetMatchesCurrent ? 'same' as const
      : legacy.current.qualification === 'custom-unqualified' ? 'custom-current' as const : 'different-supported' as const;
  const writeIntent = legacy.phase === 'completed'
    ? 'update-oem' as const
    : targetRelation === 'custom-current' ? 'restore-oem' as const
      : targetRelation === 'different-supported' ? 'update-oem' as const : undefined;
  const rest = { ...legacy };
  Reflect.deleteProperty(rest, 'target');
  Reflect.deleteProperty(rest, 'updateAvailable');
  return firmwareUpdateStateSchema.parse({
    ...rest,
    phase: legacy.phase === 'custom-firmware' ? 'available' : legacy.phase,
    target,
    targetRelation,
    ...(writeIntent ? { writeIntent } : {}),
    updateAvailable: targetRelation !== 'unknown' && targetRelation !== 'same',
    ...(legacy.artifact ? { artifact: { ...legacy.artifact, targetId: target.targetId } } : {}),
    ...(legacy.phase === 'custom-firmware' ? { warning: legacy.warning } : {}),
  });
}

function isMigratableUnpreparedV1Journal(journal: FirmwareJournalV1): boolean {
  const state = journal.state;
  return state.writeDisposition === 'not-started'
    && state.preparation === undefined
    && state.writeStartedAt === undefined
    && state.writeCompletedAt === undefined
    && state.completedAt === undefined
    && state.flashProgress === undefined
    && !state.dfuDevice.detected
    && ['idle', 'available', 'downloading', 'verified', 'up-to-date', 'custom-firmware', 'failed'].includes(state.phase);
}

function isExactUnpreparedV1Migration(
  legacy: FirmwareJournalV1,
  migrated: Extract<HistoricalFirmwareJournal, { schemaVersion: 2 }>,
): boolean {
  if (!isMigratableUnpreparedV1Journal(legacy)) return false;
  if (Date.parse(migrated.writtenAt) < Date.parse(legacy.writtenAt)) return false;
  return isDeepStrictEqual(migrated.state, activeStateFromHistoricalJournal(legacy));
}

async function readSafeUnpreparedV1MigrationPair(
  v1Path: string,
  v2Path: string,
): Promise<{ legacy: FirmwareJournalV1; migrated: Extract<HistoricalFirmwareJournal, { schemaVersion: 2 }> } | undefined> {
  try {
    const legacy = parseHistoricalFirmwareJournal(parseJson(await readRegularFile(v1Path, 'legacy v1 active journal'), 'legacy v1 active journal'));
    const migrated = parseHistoricalFirmwareJournal(parseJson(await readRegularFile(v2Path, 'migrated v2 active journal'), 'migrated v2 active journal'));
    if (legacy.schemaVersion !== 1 || migrated.schemaVersion !== 2 || !isExactUnpreparedV1Migration(legacy, migrated)) return undefined;
    return { legacy, migrated };
  } catch {
    return undefined;
  }
}

function auditValueForV1<Stage extends TransactionAuditStage>(stage: Stage, value: AuditValue<Stage>): unknown {
  if (stage !== 'verified-complete') return value;
  const verified = value as Extract<HistoricalTransactionAudit, { stage: 'verified-complete' }>['value'];
  return {
    ...verified,
    identity: {
      ...verified.identity,
      firmwareVersion: OEM_ZS407_FIRMWARE_RELEASE.version,
      firmwareReportedRevision: OEM_ZS407_FIRMWARE_RELEASE.revision,
      firmwareSourceCommit: OEM_ZS407_FIRMWARE_RELEASE.sourceCommit,
      firmwareQualification: 'supported-oem',
    },
  };
}
