import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, type Dirent } from 'node:fs';
import { access, mkdir, open, readFile, readdir, rename, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import {
  OEM_ZS407_FIRMWARE_RELEASE,
  TINYSA_USB_PRODUCT_ID,
  TINYSA_USB_VENDOR_ID,
  firmwareFlashRequestSchema,
  firmwareUpdateJournalSchema,
  firmwareUpdatePreflightSchema,
  initialFirmwareUpdateState,
  lookupSupportedZs407OemFirmware,
  type DeviceDiagnostics,
  type DeviceSnapshot,
  type DfuIdentity,
  type FirmwareFlashRequest,
  type FirmwareUpdatePreflight,
  type FirmwareUpdateState,
  type PortCandidate,
  type ScreenFrame,
} from './contracts.js';
import { JOURNAL_FILENAME, MIGRATION_CONFLICT_FILENAME, inspectFirmwareSafetyEvidence } from './legacy-migration.js';

const MINIMUM_UPDATE_BATTERY_MV = 4_000;
const DFU_CONFIRMATION_OUTPUT = /Download done[.\s]|File downloaded successfully/i;
const WRITE_LOCK_FILENAME = 'firmware-write.lock';
const JOURNAL_LOCK_FILENAME = 'firmware-journal.lock';
const LEDGER_DIRECTORY = 'completed-ledger-v1';
const DFU_OBSERVATION_LIMIT = 2 * 1024 * 1024;

export interface FirmwareUpdateDevice {
  snapshot(): DeviceSnapshot;
  readDiagnostics(): Promise<DeviceDiagnostics>;
  captureScreen(): Promise<ScreenFrame>;
  disconnect(): Promise<void>;
  listDevices(): Promise<PortCandidate[]>;
  connect(candidate: PortCandidate): Promise<DeviceSnapshot>;
}

export interface DfuExecutionResult {
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  exceededExpectedDuration: boolean;
}

export interface FirmwareUpdaterRuntime {
  fetch(url: string, init: RequestInit): Promise<Response>;
  locateDfuUtility(): Promise<string | undefined>;
  runExecutable(file: string, args: readonly string[], timeout: number): Promise<{ stdout: string; stderr: string }>;
  runDfuExecutable(
    file: string,
    args: readonly string[],
    expectedDuration: number,
    onProgress: (progress: DfuTransferProgress) => void,
  ): Promise<DfuExecutionResult>;
  verifyArtifact(bytes: Uint8Array): void;
  delay(milliseconds: number): Promise<void>;
  beforeWriteLockAcquire(preparationId: string): Promise<void>;
}

type LockPurpose = 'firmware-write' | 'journal-mutation';
interface OwnedLock { handle: FileHandle; path: string; token: string; purpose: LockPurpose; }

export class FirmwareUpdater {
  readonly #artifactPath: string;
  readonly #journalPath: string;
  readonly #writeLockPath: string;
  readonly #journalLockPath: string;
  #dfuUtilityPath: string | undefined;
  #dfuInspection: Promise<void> | undefined;
  #dfuInspectedAt = 0;
  #journalLoaded = false;
  #expectedJournalSha256: string | undefined;
  #ownedWriteLockToken: string | undefined;
  #completedSessionArchived = false;
  #state: FirmwareUpdateState = initialFirmwareUpdateState();
  readonly #runtime: FirmwareUpdaterRuntime;

  constructor(private readonly cacheDirectory: string, private readonly device: FirmwareUpdateDevice, runtime: Partial<FirmwareUpdaterRuntime> = {}) {
    this.#artifactPath = join(cacheDirectory, `${OEM_ZS407_FIRMWARE_RELEASE.version}.bin`);
    this.#journalPath = join(cacheDirectory, JOURNAL_FILENAME);
    this.#writeLockPath = join(cacheDirectory, WRITE_LOCK_FILENAME);
    this.#journalLockPath = join(cacheDirectory, JOURNAL_LOCK_FILENAME);
    this.#runtime = { ...DEFAULT_RUNTIME, ...runtime };
  }

  async state(): Promise<FirmwareUpdateState> {
    await this.#loadJournal();
    this.#synchronizeDevice();
    if (this.#state.phase === 'available' && !this.#state.artifact) await this.#inspectCachedArtifact();
    if (!['flashing', 'reconnecting'].includes(this.#state.phase)) await this.#inspectDfuUtility();
    return structuredClone(this.#state);
  }

  snapshot(): FirmwareUpdateState {
    if (!this.#journalLoaded) throw new Error('Firmware updater has not completed initial state recovery');
    return structuredClone(this.#state);
  }

  async refreshPrerequisites(): Promise<FirmwareUpdateState> {
    await this.#loadJournal();
    await this.#inspectDfuUtility(true);
    return structuredClone(this.#state);
  }

  async download(): Promise<FirmwareUpdateState> {
    await this.#loadJournal();
    this.#requireWriteNotStarted();
    this.#requireOutdatedPhysicalDevice();
    this.#state = { ...this.#state, phase: 'downloading', error: undefined, artifact: undefined };
    const temporaryPath = `${this.#artifactPath}.${randomUUID()}.part`;
    try {
      const response = await this.#runtime.fetch(OEM_ZS407_FIRMWARE_RELEASE.downloadUrl, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        headers: { Accept: 'application/octet-stream' },
      });
      if (!response.ok) throw new Error(`OEM firmware server returned HTTP ${response.status}`);
      const declaredLength = response.headers.get('content-length');
      if (declaredLength !== String(OEM_ZS407_FIRMWARE_RELEASE.sizeBytes)) {
        throw new Error(`OEM firmware Content-Length ${declaredLength ?? 'missing'} does not match pinned ${OEM_ZS407_FIRMWARE_RELEASE.sizeBytes}`);
      }
      const bytes = await readResponseBodyBounded(response, OEM_ZS407_FIRMWARE_RELEASE.sizeBytes);
      this.#runtime.verifyArtifact(bytes);
      await mkdir(this.cacheDirectory, { recursive: true, mode: 0o700 });
      await writeFile(temporaryPath, bytes, { flag: 'wx', mode: 0o600 });
      await rename(temporaryPath, this.#artifactPath);
      await syncDirectory(this.cacheDirectory);
      this.#state = {
        ...this.#state,
        phase: 'verified',
        artifact: {
          sizeBytes: OEM_ZS407_FIRMWARE_RELEASE.sizeBytes,
          sha256: OEM_ZS407_FIRMWARE_RELEASE.sha256,
          verifiedAt: new Date().toISOString(),
        },
        error: undefined,
      };
      return structuredClone(this.#state);
    } catch (value) {
      let cleanupFailure: unknown;
      try { await rm(temporaryPath, { force: true }); } catch (cleanupValue) { cleanupFailure = cleanupValue; }
      const cleanup = cleanupFailure ? `. Temporary file cleanup also failed: ${message(cleanupFailure)}` : '';
      throw await this.#fail(`Firmware download verification failed: ${message(value)}${cleanup}`);
    }
  }

  async prepare(input: FirmwareUpdatePreflight): Promise<FirmwareUpdateState> {
    await this.#loadJournal();
    this.#requireWriteNotStarted();
    const preflight = firmwareUpdatePreflightSchema.parse(input);
    this.#requireOutdatedPhysicalDevice();
    if (this.#state.phase !== 'verified' || !this.#state.artifact) throw new Error('The exact OEM firmware must be downloaded and verified before preparation');
    try {
      const diagnostics = await this.device.readDiagnostics();
      const port = diagnostics.identity.port;
      if (!diagnostics.identity.usbIdentityVerified
        || port.usbMatch !== 'exact-zs407-cdc'
        || port.vendorId?.toLowerCase() !== TINYSA_USB_VENDOR_ID
        || port.productId?.toLowerCase() !== TINYSA_USB_PRODUCT_ID) {
        throw new Error('Preflight diagnostics did not retain exact physical USB 0483:5740 identity');
      }
      if (diagnostics.telemetry.batteryMillivolts < MINIMUM_UPDATE_BATTERY_MV) {
        throw new Error(`Battery is ${diagnostics.telemetry.batteryMillivolts} mV; firmware update requires at least ${MINIMUM_UPDATE_BATTERY_MV} mV`);
      }
      const screen = await this.device.captureScreen();
      const preparation = {
        id: randomUUID(),
        preparedAt: new Date().toISOString(),
        batteryMillivolts: diagnostics.telemetry.batteryMillivolts,
        deviceId: diagnostics.telemetry.deviceId,
        screenSha256: sha256(screen.pixels),
        ...preflight,
        usbContinuity: {
          cdcPath: port.path,
          ...(port.serialNumber ? { cdcSerialNumber: port.serialNumber } : {}),
          vendorId: TINYSA_USB_VENDOR_ID,
          productId: TINYSA_USB_PRODUCT_ID,
          deviceId: diagnostics.telemetry.deviceId,
        },
      } as const;
      await mkdir(this.cacheDirectory, { recursive: true, mode: 0o700 });
      await writeFile(join(this.cacheDirectory, `preflight-${preparation.id}.json`), JSON.stringify({
        schemaVersion: 1,
        target: OEM_ZS407_FIRMWARE_RELEASE,
        preparation,
        identity: diagnostics.identity,
        firmwareVersionResponse: diagnostics.firmwareVersionResponse,
        infoLines: diagnostics.infoLines,
        commands: diagnostics.commands,
        telemetry: diagnostics.telemetry,
        artifact: this.#state.artifact,
      }, null, 2), { flag: 'wx', mode: 0o600 });
      this.#state = {
        ...this.#state,
        phase: 'awaiting-dfu',
        preparation,
        dfuDevice: { detected: false, count: 0 },
        continuityWarning: 'USB CDC and STM32 DFU do not expose a publicly proven common identifier. TinySA Flasher records both identities, requires one exact DFU target, requires the only-USB-device attestation, and verifies the CDC device ID and serial after reboot; it does not claim cross-mode identity equivalence.',
        error: undefined,
      };
      await this.#persistJournal();
      await this.device.disconnect();
      return structuredClone(this.#state);
    } catch (value) {
      throw await this.#fail(`Firmware preflight failed: ${message(value)}`);
    }
  }

  async detectDfu(): Promise<FirmwareUpdateState> {
    await this.#loadJournal();
    this.#requireWriteNotStarted();
    if (!this.#state.preparation) throw new Error('Firmware update has no completed preflight record');
    try {
      const utility = await this.#requireDfuUtility();
      const listing = await this.#runtime.runExecutable(utility, ['-l'], 15_000);
      const inspection = inspectStm32DfuDevices(`${listing.stdout}\n${listing.stderr}`);
      const identity = exactOneDfuIdentity(inspection);
      this.#state = {
        ...this.#state,
        phase: identity ? 'ready-to-flash' : 'awaiting-dfu',
        dfuDevice: identity
          ? { detected: true, count: 1, identity }
          : { detected: false, count: inspection.deviceCount },
        error: undefined,
      };
      await this.#persistJournal();
      return structuredClone(this.#state);
    } catch (value) {
      throw await this.#fail(`DFU detection failed: ${message(value)}`);
    }
  }

  async flash(input: FirmwareFlashRequest): Promise<FirmwareUpdateState> {
    await this.#loadJournal();
    this.#requireWriteNotStarted();
    const request = firmwareFlashRequestSchema.parse(input);
    const preparation = this.#state.preparation;
    const detectedIdentity = this.#state.dfuDevice.identity;
    if (!preparation || preparation.id !== request.preparationId) throw new Error('Firmware flash preparation token does not match');
    if (this.#state.phase !== 'ready-to-flash' || !this.#state.dfuDevice.detected || this.#state.dfuDevice.count !== 1 || !detectedIdentity) {
      throw new Error('Exactly one persisted STM32 DFU internal-flash target is required before flashing');
    }

    let ownedLock: OwnedLock | undefined;
    let sessionArchived = false;
    let writeBoundaryPersisted = false;
    try {
      const utility = await this.#requireDfuUtility();
      this.#runtime.verifyArtifact(new Uint8Array(await readFile(this.#artifactPath)));

      // Close the detection-to-write race: enumerate again and require the same
      // canonical target identity before creating any write-attempt evidence.
      const listing = await this.#runtime.runExecutable(utility, ['-l'], 15_000);
      const immediate = exactOneDfuIdentity(inspectStm32DfuDevices(`${listing.stdout}\n${listing.stderr}`));
      if (!immediate || immediate.fingerprint !== detectedIdentity.fingerprint) {
        throw new Error('DFU target identity changed after detection; no write was attempted');
      }

      await this.#runtime.beforeWriteLockAcquire(preparation.id);
      ownedLock = await this.#acquireWriteLock(preparation.id, immediate);
      const writeStartedAt = new Date().toISOString();
      await this.#persistJournal(async () => {
        await this.#assertSharedReadyJournal(preparation.id, immediate.fingerprint);
        await this.#assertNoPriorCompletedEvidence(preparation.deviceId, preparation.id);
        this.#state = {
          ...this.#state,
          phase: 'flashing',
          writeDisposition: 'started',
          writeStartedAt,
          flashProgress: { stage: 'preparing', percent: 0, updatedAt: writeStartedAt },
          error: undefined,
        };
      });
      writeBoundaryPersisted = true;
      await this.#writeResultAudit('write-started', { preparationId: preparation.id, writeStartedAt, dfuIdentity: immediate });

      const transfer = await this.#runtime.runDfuExecutable(
        utility,
        ['-d', '0483:df11', '-p', immediate.path, '-S', immediate.serial, '-a', '0', '-s', '0x08000000:leave', '-D', this.#artifactPath],
        120_000,
        (progress) => {
          const stage = progress.operation === 'erase' ? 'erasing' : 'writing';
          const percent = progress.operation === 'erase' ? Math.round(progress.percent * 0.4) : 40 + Math.round(progress.percent * 0.55);
          this.#state = { ...this.#state, flashProgress: { stage, percent, stagePercent: progress.percent, updatedAt: new Date().toISOString() } };
        },
      );
      const output = `${transfer.stdout}\n${transfer.stderr}`;
      if (!DFU_CONFIRMATION_OUTPUT.test(output)) throw new Error('dfu-util exited without its successful-download confirmation');
      const writeCompletedAt = new Date().toISOString();
      this.#state = {
        ...this.#state,
        phase: 'reconnecting',
        writeDisposition: 'completed',
        writeCompletedAt,
        flashProgress: { stage: 'verifying-reboot', percent: 98, stagePercent: 100, updatedAt: writeCompletedAt },
      };
      await this.#persistJournal();
      await this.#writeResultAudit('write-complete', {
        preparationId: preparation.id,
        writeCompletedAt,
        dfuIdentity: immediate,
        output: bounded(output),
        outputTruncated: transfer.outputTruncated,
        exceededExpectedDuration: transfer.exceededExpectedDuration,
      });

      const candidate = await this.#waitForOnePhysicalDevice(preparation.usbContinuity.cdcSerialNumber);
      if (preparation.usbContinuity.cdcSerialNumber && candidate.serialNumber
        && candidate.serialNumber !== preparation.usbContinuity.cdcSerialNumber) {
        throw new Error('Post-reboot CDC serial does not match the preflight serial');
      }
      const connected = await this.device.connect(candidate);
      if (connected.telemetry?.deviceId !== preparation.deviceId) {
        await this.#disconnectAfterMismatch();
        throw new Error(`Post-reboot device ID ${String(connected.telemetry?.deviceId ?? 'missing')} does not match preflight ID ${preparation.deviceId}`);
      }
      if (connected.identity?.firmwareVersion !== OEM_ZS407_FIRMWARE_RELEASE.version
        || connected.identity.firmwareQualification !== 'supported-oem'
        || connected.identity.firmwareReportedRevision !== OEM_ZS407_FIRMWARE_RELEASE.revision
        || connected.identity.firmwareSourceCommit !== OEM_ZS407_FIRMWARE_RELEASE.sourceCommit) {
        const identityError = `Post-flash identity is ${connected.identity?.firmwareVersion ?? 'missing'}, expected ${OEM_ZS407_FIRMWARE_RELEASE.version}`;
        await this.#disconnectAfterMismatch();
        throw new Error(identityError);
      }
      const completedAt = new Date().toISOString();
      this.#state = {
        ...this.#state,
        phase: 'completed',
        updateAvailable: false,
        current: {
          version: connected.identity.firmwareVersion,
          revision: connected.identity.firmwareReportedRevision,
          sourceCommit: connected.identity.firmwareSourceCommit,
          qualification: 'supported-oem',
        },
        flashProgress: { stage: 'complete', percent: 100, stagePercent: 100, updatedAt: completedAt },
        completedAt,
        error: undefined,
      };
      await this.#writeResultAudit('verified-complete', {
        preparationId: preparation.id,
        writeCompletedAt,
        completedAt,
        identity: connected.identity,
        deviceId: connected.telemetry.deviceId,
      });
      await this.#persistJournal();

      await this.#archiveCompletedSession(preparation.deviceId, preparation.id);
      sessionArchived = true;
      await this.#releaseKnownLock(ownedLock);
      ownedLock = undefined;
      return structuredClone(this.#state);
    } catch (value) {
      if (value instanceof NonOwnedSessionError
        || (!ownedLock && this.#state.writeDisposition === 'not-started' && await exists(this.#writeLockPath))) {
        let cleanup = '';
        if (ownedLock && !writeBoundaryPersisted) {
          try { await this.#releaseKnownLock(ownedLock); }
          catch (cleanupFailure) { cleanup = ` Known-new lock cleanup failed and the lock was retained: ${message(cleanupFailure)}`; }
          ownedLock = undefined;
        } else if (ownedLock) {
          try { await ownedLock.handle.close(); } catch { /* Preserve the active lock and journal. */ }
        }
        const error = `A different or stale firmware session owns the shared write boundary. This process is permanently blocked and did not modify the shared journal: ${message(value)}${cleanup}`;
        this.#state = { ...this.#state, phase: 'failed', writeDisposition: 'indeterminate', error };
        throw new Error(error, { cause: value });
      }
      if (ownedLock) {
        try { await ownedLock.handle.close(); } catch { /* Preserve the active lock and journal. */ }
      }
      if (sessionArchived || this.#completedSessionArchived) {
        const error = `Firmware completed and entered the immutable ledger, but its owner lock could not be released. Flashing remains manually locked: ${message(value)}`;
        this.#state = { ...this.#state, phase: 'failed', error };
        throw new Error(error, { cause: value });
      }
      const prefix = this.#state.writeDisposition === 'not-started'
        ? 'Firmware flash failed before any write attempt began'
        : this.#state.writeDisposition === 'completed'
          ? 'Firmware write completed but post-flash verification failed; do not flash again'
          : 'Firmware write may have begun but completion is unverified; do not flash again';
      throw await this.#fail(`${prefix}: ${message(value)}`);
    }
  }

  async #loadJournal(): Promise<void> {
    if (this.#journalLoaded) return;
    this.#journalLoaded = true;
    if (await exists(join(this.cacheDirectory, MIGRATION_CONFLICT_FILENAME))) {
      this.#state = {
        ...initialFirmwareUpdateState(),
        phase: 'failed',
        writeDisposition: 'indeterminate',
        error: 'Conflicting legacy firmware journals were found. Flashing is locked pending manual inspection; no journal was selected.',
      };
      return;
    }
    if (await exists(this.#journalLockPath)) {
      this.#state = {
        ...initialFirmwareUpdateState(),
        phase: 'failed',
        writeDisposition: 'indeterminate',
        error: 'A durable firmware journal mutex already exists. Another process may be mutating safety evidence, or a prior mutation was interrupted; flashing is locked pending manual inspection.',
      };
      return;
    }
    const evidenceIssues = await inspectFirmwareSafetyEvidence(this.cacheDirectory);
    if (evidenceIssues.length) {
      this.#state = {
        ...initialFirmwareUpdateState(),
        phase: 'failed',
        writeDisposition: 'indeterminate',
        error: `Firmware transaction evidence is orphaned or inconsistent. Flashing is locked pending manual inspection: ${evidenceIssues.join('; ')}`,
      };
      return;
    }

    let journal: ReturnType<typeof firmwareUpdateJournalSchema.parse>;
    try {
      const bytes = new Uint8Array(await readFile(this.#journalPath));
      this.#expectedJournalSha256 = sha256(bytes);
      journal = firmwareUpdateJournalSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    } catch (value) {
      if (isFileMissing(value)) {
        this.#expectedJournalSha256 = undefined;
        if (await exists(this.#writeLockPath)) {
          this.#state = {
            ...initialFirmwareUpdateState(),
            phase: 'failed',
            writeDisposition: 'indeterminate',
            error: 'An exclusive firmware write lock exists without a valid active journal. Flashing is locked pending manual inspection.',
          };
        }
        return;
      }
      this.#state = {
        ...initialFirmwareUpdateState(),
        phase: 'failed',
        writeDisposition: 'indeterminate',
        error: `Firmware journal is invalid or unreadable. Flashing is locked pending manual inspection: ${message(value)}`,
      };
      return;
    }
    this.#state = journal.state;
    const lockExists = await exists(this.#writeLockPath);
    if (lockExists) {
      this.#state = {
        ...this.#state,
        phase: 'failed',
        ...(this.#state.writeDisposition === 'not-started' ? { writeDisposition: 'indeterminate' as const } : {}),
        error: this.#state.writeDisposition === 'not-started'
          ? 'A firmware write lock exists but the journal has no durable write start. Flashing is locked pending manual inspection.'
          : 'A firmware write lock from another or interrupted process still protects this transaction. No recovery mutation was attempted; inspect it before continuing.',
      };
      return;
    }
    if (this.#state.phase === 'completed') {
      if (this.#state.preparation) {
        try { await this.#archiveCompletedSession(this.#state.preparation.deviceId, this.#state.preparation.id); }
        catch (value) { this.#state = { ...this.#state, phase: 'failed', error: `Completed-session ledger recovery failed: ${message(value)}` }; }
      }
      return;
    }
    if (this.#state.phase === 'ready-to-flash') {
      this.#state = { ...this.#state, phase: 'awaiting-dfu', dfuDevice: { detected: false, count: 0 }, error: undefined };
    } else if (this.#state.phase === 'flashing' || this.#state.phase === 'reconnecting') {
      this.#state = {
        ...this.#state,
        phase: 'failed',
        error: this.#state.writeDisposition === 'completed'
          ? 'The previous TinySA Flasher process ended after bytes were written. Do not flash again; verify the rebooted USB identity.'
          : 'The previous TinySA Flasher process ended after the firmware write attempt began. Completion is unknown; do not flash again.',
      };
    } else {
      return;
    }
    try { await this.#persistJournal(); }
    catch (value) { this.#state = { ...this.#state, error: `${this.#state.error ?? 'Recovered journal state.'} Recovery could not be persisted: ${message(value)}` }; }
  }

  async #persistJournal(beforeWrite?: () => Promise<void>): Promise<void> {
    await mkdir(this.cacheDirectory, { recursive: true, mode: 0o700 });
    await this.#withJournalMutation(async () => {
      if (beforeWrite) await beforeWrite();
      const temporaryPath = `${this.#journalPath}.${randomUUID()}.part`;
      const journal = firmwareUpdateJournalSchema.parse({
        schemaVersion: 1,
        targetVersion: OEM_ZS407_FIRMWARE_RELEASE.version,
        writtenAt: new Date().toISOString(),
        state: this.#state,
      });
      const body = JSON.stringify(journal, null, 2);
      try {
        const handle = await open(temporaryPath, 'wx', 0o600);
        try { await handle.writeFile(body, 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporaryPath, this.#journalPath);
        this.#expectedJournalSha256 = sha256(new TextEncoder().encode(body));
        await syncDirectory(this.cacheDirectory);
      } catch (value) {
        try { await rm(temporaryPath, { force: true }); }
        catch (cleanupFailure) { throw new Error(`${message(value)}. Journal temporary cleanup also failed: ${message(cleanupFailure)}`, { cause: value }); }
        throw value;
      }
    });
  }

  async #archiveCompletedSession(deviceId: number, preparationId: string): Promise<void> {
    if (this.#state.phase !== 'completed' || this.#state.writeDisposition !== 'completed') throw new Error('Only a verified completed session can enter the completed ledger');
    await this.#withJournalMutation(async () => {
      const ledgerDirectory = join(this.cacheDirectory, LEDGER_DIRECTORY);
      await mkdir(ledgerDirectory, { recursive: true, mode: 0o700 });
      const destination = join(ledgerDirectory, `device-${deviceId}-preparation-${preparationId}.json`);
      if (await exists(destination)) throw new NonOwnedSessionError('A completed ledger entry already exists for this preparation; the active journal will not be deleted or replaced');
      try { await rename(this.#journalPath, destination); }
      catch (value) {
        if (isFileMissing(value)) throw new NonOwnedSessionError('Verified completed session has no active journal to archive');
        throw value;
      }
      this.#completedSessionArchived = true;
      this.#expectedJournalSha256 = undefined;
      await syncDirectory(ledgerDirectory);
      await syncDirectory(this.cacheDirectory);
    });
  }

  async #withJournalMutation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      const lock = await this.#createOwnedLock(this.#journalLockPath, 'journal-mutation');
      try {
        await this.#assertWriteBoundary();
        await this.#assertJournalGeneration();
        return await operation();
      } finally {
        await this.#releaseKnownLock(lock);
      }
    } catch (value) {
      if (value instanceof NonOwnedSessionError) {
        this.#state = {
          ...this.#state,
          phase: 'failed',
          writeDisposition: 'indeterminate',
          error: `Shared firmware safety evidence is owned by another or newer session: ${message(value)}`,
        };
      }
      throw value;
    }
  }

  async #acquireWriteLock(preparationId: string, identity: DfuIdentity): Promise<OwnedLock> {
    await mkdir(this.cacheDirectory, { recursive: true, mode: 0o700 });
    if (this.#ownedWriteLockToken) throw new Error('This updater instance already owns a firmware write lock');
    const lock = await this.#createOwnedLock(this.#writeLockPath, 'firmware-write', { preparationId, dfuIdentity: identity });
    this.#ownedWriteLockToken = lock.token;
    return lock;
  }

  async #createOwnedLock(path: string, purpose: LockPurpose, detail: Record<string, unknown> = {}): Promise<OwnedLock> {
    const token = randomUUID();
    let handle: FileHandle;
    try { handle = await open(path, 'wx', 0o600); }
    catch (value) {
      if (hasCode(value, 'EEXIST')) {
        const label = purpose === 'firmware-write' ? 'firmware write lock' : 'firmware journal mutex';
        throw new NonOwnedSessionError(`An exclusive ${label} already exists; this process will not mutate shared safety evidence`);
      }
      throw value;
    }
    try {
      await handle.writeFile(JSON.stringify({ schemaVersion: 1, purpose, ownerToken: token, acquiredAt: new Date().toISOString(), ...detail }, null, 2), 'utf8');
      await handle.sync();
      await syncDirectory(this.cacheDirectory);
      return { handle, path, token, purpose };
    } catch (value) {
      await handle.close();
      // A partially created lock is retained deliberately: ambiguity is safer
      // than silently permitting a second process to write.
      throw value;
    }
  }

  async #releaseKnownLock(lock: OwnedLock): Promise<void> {
    let record: LockRecord;
    try { record = await readLockRecord(lock.path); }
    catch (value) {
      try { await lock.handle.close(); } catch { /* The path is retained for manual inspection. */ }
      throw new NonOwnedSessionError(`Owned ${lock.purpose} lock became unreadable before release: ${message(value)}`);
    }
    if (record.ownerToken !== lock.token || record.purpose !== lock.purpose) {
      try { await lock.handle.close(); } catch { /* Never unlink a path whose token changed. */ }
      throw new NonOwnedSessionError(`Owned ${lock.purpose} lock token changed; the current path was not removed`);
    }
    await lock.handle.close();
    await rm(lock.path);
    await syncDirectory(this.cacheDirectory);
    if (lock.purpose === 'firmware-write' && this.#ownedWriteLockToken === lock.token) this.#ownedWriteLockToken = undefined;
  }

  async #assertWriteBoundary(): Promise<void> {
    let record: LockRecord;
    try { record = await readLockRecord(this.#writeLockPath); }
    catch (value) {
      if (isFileMissing(value)) {
        if (this.#ownedWriteLockToken) throw new NonOwnedSessionError('The locally owned firmware write lock disappeared');
        return;
      }
      throw new NonOwnedSessionError(`The shared firmware write lock is invalid or unreadable: ${message(value)}`);
    }
    if (record.purpose !== 'firmware-write'
      || !this.#ownedWriteLockToken
      || record.ownerToken !== this.#ownedWriteLockToken) {
      throw new NonOwnedSessionError('Another process owns the shared firmware write boundary');
    }
  }

  async #assertJournalGeneration(): Promise<void> {
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(await readFile(this.#journalPath)); }
    catch (value) {
      if (isFileMissing(value) && this.#expectedJournalSha256 === undefined) return;
      if (isFileMissing(value)) throw new NonOwnedSessionError('The expected active journal was removed or archived by another session');
      throw new NonOwnedSessionError(`The active journal cannot be read for generation verification: ${message(value)}`);
    }
    const actual = sha256(bytes);
    if (this.#expectedJournalSha256 === undefined) throw new NonOwnedSessionError('An unexpected active journal appeared after this process loaded state');
    if (actual !== this.#expectedJournalSha256) throw new NonOwnedSessionError('The active journal generation changed after this process loaded state');
  }

  async #assertNoPriorCompletedEvidence(deviceId: number, preparationId: string): Promise<void> {
    const ledgerDirectory = join(this.cacheDirectory, LEDGER_DIRECTORY);
    if (await exists(join(ledgerDirectory, `device-${deviceId}-preparation-${preparationId}.json`))) {
      throw new NonOwnedSessionError('This exact device preparation already has completed-ledger evidence');
    }
    await this.#assertPreparationAbsentFromLedgerTree(ledgerDirectory, preparationId);
    let entries: string[] = [];
    try { entries = await readdir(this.cacheDirectory); }
    catch (value) { if (!isFileMissing(value)) throw value; }
    if (entries.some((name) => name.startsWith(`result-${preparationId}-`) && name.endsWith('.json'))) {
      throw new NonOwnedSessionError('This preparation already has write-attempt result evidence');
    }
  }

  async #assertPreparationAbsentFromLedgerTree(directory: string, preparationId: string): Promise<void> {
    let entries: Dirent[];
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (value) { if (isFileMissing(value)) return; throw value; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new NonOwnedSessionError(`Completed ledger contains a symbolic link at ${path}`);
      if (entry.isDirectory()) { await this.#assertPreparationAbsentFromLedgerTree(path, preparationId); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      let ledger: ReturnType<typeof firmwareUpdateJournalSchema.parse>;
      try { ledger = firmwareUpdateJournalSchema.parse(JSON.parse(await readFile(path, 'utf8'))); }
      catch (value) { throw new NonOwnedSessionError(`Completed ledger entry is invalid at ${path}: ${message(value)}`); }
      if (ledger.state.phase !== 'completed' || ledger.state.writeDisposition !== 'completed' || !ledger.state.preparation) {
        throw new NonOwnedSessionError(`Completed ledger entry is not a verified transaction at ${path}`);
      }
      if (ledger.state.preparation.id === preparationId) throw new NonOwnedSessionError(`This preparation already appears in completed ledger ${path}`);
    }
  }

  async #assertSharedReadyJournal(preparationId: string, dfuFingerprint: string): Promise<void> {
    let shared: ReturnType<typeof firmwareUpdateJournalSchema.parse>;
    try { shared = firmwareUpdateJournalSchema.parse(JSON.parse(await readFile(this.#journalPath, 'utf8'))); }
    catch (value) { throw new NonOwnedSessionError(`The shared active journal is missing, invalid, completed, or archived: ${message(value)}`); }
    if (shared.state.phase !== 'ready-to-flash'
      || shared.state.writeDisposition !== 'not-started'
      || shared.state.preparation?.id !== preparationId
      || shared.state.dfuDevice.identity?.fingerprint !== dfuFingerprint
      || !shared.state.dfuDevice.detected
      || shared.state.dfuDevice.count !== 1) {
      throw new NonOwnedSessionError('The shared active journal no longer supports this exact ready preparation and DFU fingerprint');
    }
  }

  #requireWriteNotStarted(): void {
    if (this.#state.writeDisposition === 'not-started') return;
    if (this.#state.writeDisposition === 'indeterminate') throw new Error('Firmware journal integrity is indeterminate; flashing remains locked pending manual inspection');
    throw new Error('A firmware write attempt already began; TinySA Flasher will not issue another write');
  }

  #synchronizeDevice(): void {
    if (this.#state.preparation || ['downloading', 'flashing', 'reconnecting', 'completed'].includes(this.#state.phase)) return;
    const snapshot = this.device.snapshot();
    const identity = snapshot.identity;
    if (snapshot.connection !== 'ready' || !identity || !identity.usbIdentityVerified) {
      if (this.#state.phase !== 'failed') this.#state = { ...initialFirmwareUpdateState(), dfuUtility: this.#state.dfuUtility };
      return;
    }
    if (identity.firmwareQualification === 'custom-unqualified') {
      if (this.#state.phase === 'failed') return;
      this.#state = {
        ...initialFirmwareUpdateState(),
        phase: 'custom-firmware',
        current: { version: identity.firmwareVersion, revision: identity.firmwareReportedRevision, qualification: 'custom-unqualified' },
        dfuUtility: this.#state.dfuUtility,
        warning: `${identity.firmwareWarning ?? 'Custom firmware is unqualified.'} The pinned OEM updater is disabled for this session.`,
      };
      return;
    }
    const revision = identity.firmwareReportedRevision;
    const supportedFirmware = lookupSupportedZs407OemFirmware(identity.firmwareVersion);
    if (!supportedFirmware
      || supportedFirmware.revision !== revision
      || supportedFirmware.sourceCommit !== identity.firmwareSourceCommit) {
      throw new Error('Physical firmware identity has inconsistent supported-OEM provenance');
    }
    const current = { ...supportedFirmware, qualification: 'supported-oem' as const };
    const updateAvailable = revision !== OEM_ZS407_FIRMWARE_RELEASE.revision;
    const phase = this.#state.phase === 'failed' ? 'failed' : updateAvailable ? (this.#state.artifact ? 'verified' : 'available') : 'up-to-date';
    this.#state = { ...this.#state, phase, current, updateAvailable, warning: undefined, error: phase === 'failed' ? this.#state.error : undefined };
  }

  #requireOutdatedPhysicalDevice(): void {
    this.#synchronizeDevice();
    const snapshot = this.device.snapshot();
    if (snapshot.connection !== 'ready' || !snapshot.identity?.usbIdentityVerified) throw new Error('Firmware update requires one connected, exactly verified physical ZS407');
    if (snapshot.identity.firmwareQualification === 'custom-unqualified') throw new Error('The pinned OEM updater is disabled while custom unqualified firmware is connected');
    if (!this.#state.updateAvailable) throw new Error('The connected ZS407 already runs the pinned OEM firmware');
  }

  async #inspectDfuUtility(force = false): Promise<void> {
    if (!force && this.#dfuInspectedAt && Date.now() - this.#dfuInspectedAt < 30_000) return;
    if (this.#dfuInspection) return this.#dfuInspection;
    this.#dfuInspection = this.#performDfuUtilityInspection();
    try { await this.#dfuInspection; }
    finally { this.#dfuInspection = undefined; }
  }

  async #performDfuUtilityInspection(): Promise<void> {
    try {
      const path = await this.#runtime.locateDfuUtility();
      if (!path) { this.#dfuUtilityPath = undefined; this.#state = { ...this.#state, dfuUtility: { available: false } }; return; }
      const result = await this.#runtime.runExecutable(path, ['--version'], 10_000);
      const version = parseDfuUtilVersion(`${result.stdout}\n${result.stderr}`);
      this.#dfuUtilityPath = path;
      this.#state = { ...this.#state, dfuUtility: { available: true, version } };
    } catch (value) {
      this.#dfuUtilityPath = undefined;
      this.#state = { ...this.#state, dfuUtility: { available: false }, error: `DFU utility inspection failed: ${message(value)}` };
    } finally {
      this.#dfuInspectedAt = Date.now();
    }
  }

  async #inspectCachedArtifact(): Promise<void> {
    try {
      const bytes = new Uint8Array(await readFile(this.#artifactPath));
      this.#runtime.verifyArtifact(bytes);
      this.#state = {
        ...this.#state,
        phase: 'verified',
        artifact: { sizeBytes: OEM_ZS407_FIRMWARE_RELEASE.sizeBytes, sha256: OEM_ZS407_FIRMWARE_RELEASE.sha256, verifiedAt: new Date().toISOString() },
        error: undefined,
      };
    } catch (value) {
      if (isFileMissing(value)) return;
      this.#state = { ...this.#state, phase: 'failed', error: `Cached firmware verification failed: ${message(value)}` };
    }
  }

  async #requireDfuUtility(): Promise<string> {
    await this.#inspectDfuUtility(true);
    if (!this.#dfuUtilityPath || !this.#state.dfuUtility.available) throw new Error('dfu-util 0.11 is unavailable; install the exact prerequisite before entering DFU mode');
    return this.#dfuUtilityPath;
  }

  async #waitForOnePhysicalDevice(preflightSerial?: string): Promise<PortCandidate> {
    for (let attempt = 0; attempt < 30; attempt++) {
      const exact = (await this.device.listDevices()).filter((candidate) => candidate.usbMatch === 'exact-zs407-cdc');
      if (preflightSerial) {
        const matched = exact.filter((candidate) => candidate.serialNumber === preflightSerial);
        if (matched.length > 1) throw new Error(`Post-flash discovery found ${matched.length} devices with the preflight CDC serial`);
        if (matched[0]) return matched[0];
        if (exact.length) throw new Error('A ZS407 returned after flash, but its CDC serial does not match preflight');
      } else {
        if (exact.length > 1) throw new Error(`Post-flash discovery found ${exact.length} exact ZS407 candidates`);
        if (exact[0]) return exact[0];
      }
      await this.#runtime.delay(1_000);
    }
    throw new Error('The preflight ZS407 did not reappear on USB within 30 seconds');
  }

  async #disconnectAfterMismatch(): Promise<void> {
    try { await this.device.disconnect(); }
    catch (value) { throw new Error(`Post-flash identity mismatch and safe disconnect also failed: ${message(value)}`, { cause: value }); }
  }

  async #writeResultAudit(stage: string, value: unknown): Promise<void> {
    const id = this.#state.preparation?.id;
    if (!id) throw new Error('Firmware result audit is missing its preparation ID');
    const path = join(this.cacheDirectory, `result-${id}-${stage}.json`);
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ schemaVersion: 1, stage, target: OEM_ZS407_FIRMWARE_RELEASE, value }, null, 2), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(this.cacheDirectory);
  }

  async #fail(error: string): Promise<Error> {
    this.#state = { ...this.#state, phase: 'failed', error };
    if (this.#state.preparation || this.#state.writeDisposition !== 'not-started') {
      try { await this.#persistJournal(); }
      catch (value) {
        const lostOwnership = value instanceof NonOwnedSessionError;
        this.#state = {
          ...this.#state,
          phase: 'failed',
          ...(lostOwnership && this.#state.writeDisposition === 'not-started' ? { writeDisposition: 'indeterminate' as const } : {}),
          error: `${error}. Firmware journal persistence also failed: ${message(value)}${lostOwnership ? ' This process no longer owns current shared state and cannot retry.' : ''}`,
        };
      }
    }
    return new Error(this.#state.error);
  }
}

export function verifyFirmwareArtifact(bytes: Uint8Array): void {
  if (bytes.byteLength !== OEM_ZS407_FIRMWARE_RELEASE.sizeBytes) throw new Error(`Firmware has ${bytes.byteLength} bytes, expected ${OEM_ZS407_FIRMWARE_RELEASE.sizeBytes}`);
  const actual = sha256(bytes);
  if (actual !== OEM_ZS407_FIRMWARE_RELEASE.sha256) throw new Error(`Firmware SHA-256 ${actual} does not match pinned ${OEM_ZS407_FIRMWARE_RELEASE.sha256}`);
}

export interface DfuInspection { deviceCount: number; identities: DfuIdentity[]; }

export function inspectStm32DfuDevices(output: string): DfuInspection {
  const lines = output.split(/\r?\n/).filter((line) => /Found DFU:\s*\[0483:df11\]/i.test(line));
  const deviceFingerprints = new Set<string>();
  const identities: DfuIdentity[] = [];
  for (const rawLine of lines) {
    const targetLine = bounded(rawLine);
    const path = targetLine.match(/\bpath="([^"]+)"/i)?.[1];
    const devnum = targetLine.match(/\bdevnum=(\d+)\b/i)?.[1];
    const serial = targetLine.match(/\bserial="([^"]*)"/i)?.[1];
    const altText = targetLine.match(/\balt=(\d+)\b/i)?.[1];
    const name = targetLine.match(/\bname="([^"]+)"/i)?.[1];
    if (!path || !devnum || !serial || altText === undefined || !name) throw new Error(`Malformed or empty STM32 DFU identity line: ${targetLine}`);
    deviceFingerprints.add(JSON.stringify({ path, devnum, serial }));
    if (Number(altText) !== 0 || !name.startsWith('@Internal Flash')) continue;
    inspectInternalFlashDescriptor(name);
    const fingerprint = JSON.stringify({ path, devnum, serial, alt: 0, name });
    identities.push({ path, devnum, serial, alt: 0, name, fingerprint, targetLine });
  }
  return { deviceCount: deviceFingerprints.size, identities };
}

export function exactOneDfuIdentity(inspection: DfuInspection): DfuIdentity | undefined {
  if (inspection.deviceCount > 1) throw new Error(`Detected ${inspection.deviceCount} STM32 DFU devices; exactly one physical device is required`);
  if (inspection.deviceCount === 1 && inspection.identities.length !== 1) throw new Error(`The STM32 DFU device exposes ${inspection.identities.length} exact alt-0 internal-flash targets; exactly one is required`);
  return inspection.deviceCount === 1 ? inspection.identities[0] : undefined;
}

export function parseDfuUtilVersion(output: string): string {
  const versionLine = output.split(/\r?\n/).map((line) => line.trim()).find((line) => /^dfu-util\b/i.test(line));
  const version = versionLine?.match(/^dfu-util\s+(\S+)$/i)?.[1];
  if (version !== '0.11') throw new Error(`dfu-util version ${version ?? 'missing'} is unsupported; TinySA Flasher requires 0.11`);
  return version;
}

export function inspectInternalFlashDescriptor(name: string): { startAddress: number; capacityBytes: number } {
  const match = name.match(/^@Internal Flash\s+\/0x([0-9a-f]+)\/(.+)$/i);
  if (!match) throw new Error(`Malformed STM32 internal-flash descriptor: ${name}`);
  const startAddress = Number.parseInt(match[1]!, 16);
  if (startAddress !== 0x08000000) throw new Error(`STM32 internal flash starts at 0x${startAddress.toString(16)}, expected 0x08000000`);
  let capacityBytes = 0;
  for (const segment of match[2]!.split(',')) {
    const geometry = segment.trim().match(/^(\d+)\s*\*\s*(\d+)\s*([KMG]?)([a-g])$/i);
    if (!geometry) throw new Error(`Malformed STM32 flash geometry segment: ${segment.trim()}`);
    const attributes = geometry[4]!.toLowerCase();
    if (attributes !== 'f' && attributes !== 'g') throw new Error(`STM32 flash geometry segment is not both erasable and writable: ${segment.trim()}`);
    const multiplier = geometry[3]!.toUpperCase() === 'K' ? 1024
      : geometry[3]!.toUpperCase() === 'M' ? 1024 * 1024
        : geometry[3]!.toUpperCase() === 'G' ? 1024 * 1024 * 1024
          : 1;
    const bytes = Number(geometry[1]) * Number(geometry[2]) * multiplier;
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`Invalid STM32 flash geometry segment: ${segment.trim()}`);
    capacityBytes += bytes;
  }
  if (!Number.isSafeInteger(capacityBytes) || capacityBytes < OEM_ZS407_FIRMWARE_RELEASE.sizeBytes) {
    throw new Error(`STM32 internal-flash capacity ${capacityBytes} bytes is smaller than pinned image ${OEM_ZS407_FIRMWARE_RELEASE.sizeBytes}`);
  }
  return { startAddress, capacityBytes };
}

export async function readResponseBodyBounded(response: Response, exactBytes: number): Promise<Uint8Array> {
  if (!response.body) throw new Error('OEM firmware response has no body');
  const output = new Uint8Array(exactBytes);
  const reader = response.body.getReader();
  let offset = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (offset + next.value.byteLength > exactBytes) {
        await reader.cancel('Pinned firmware byte bound exceeded');
        throw new Error(`OEM firmware body exceeds pinned ${exactBytes}-byte bound`);
      }
      output.set(next.value, offset);
      offset += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (offset !== exactBytes) throw new Error(`OEM firmware body has ${offset} bytes, expected exactly ${exactBytes}`);
  return output;
}

export interface DfuTransferProgress { operation: 'erase' | 'download'; percent: number; }

export function parseDfuTransferProgress(output: string): DfuTransferProgress | undefined {
  const matches = [...output.matchAll(/(?:^|[\r\n])(Erase|Download)\s+\[[^\]]*\]\s+(\d{1,3})%/gim)];
  const match = matches.at(-1);
  if (!match) return undefined;
  const percent = Number(match[2]);
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) return undefined;
  return { operation: match[1]!.toLowerCase() as DfuTransferProgress['operation'], percent };
}

async function locateDfuUtility(): Promise<string | undefined> {
  const explicit = process.env.TINYSA_DFU_UTIL?.trim();
  if (explicit) {
    await access(explicit, fsConstants.X_OK).catch(() => { throw new Error(`TINYSA_DFU_UTIL is not executable: ${explicit}`); });
    return explicit;
  }
  const candidates = [
    '/opt/homebrew/bin/dfu-util', '/usr/local/bin/dfu-util', '/usr/bin/dfu-util',
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map((directory) => join(directory, 'dfu-util')),
  ];
  for (const candidate of [...new Set(candidates)]) {
    try { await access(candidate, fsConstants.X_OK); return candidate; } catch { /* Continue deterministic path discovery. */ }
  }
  return undefined;
}

function runExecutable(file: string, args: readonly string[], timeout: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout, maxBuffer: DFU_OBSERVATION_LIMIT, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${file} ${args.join(' ')} failed: ${bounded(stderr || stdout || error.message)}`, { cause: error }));
      else resolve({ stdout, stderr });
    });
  });
}

function runDfuExecutable(
  file: string,
  args: readonly string[],
  expectedDuration: number,
  onProgress: (progress: DfuTransferProgress) => void,
): Promise<DfuExecutionResult> {
  const child = spawn(file, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  return observeDfuExecution(child as ObservableDfuChild, file, args, expectedDuration, onProgress);
}

interface ObservableDfuChild {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export function observeDfuExecution(
  child: ObservableDfuChild,
  file: string,
  args: readonly string[],
  expectedDuration: number,
  onProgress: (progress: DfuTransferProgress) => void,
): Promise<DfuExecutionResult> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let progressTail = '';
    let lastProgress = '';
    let outputTruncated = false;
    let exceededExpectedDuration = false;
    const observationFaults: string[] = [];
    const durationTimer = setTimeout(() => { exceededExpectedDuration = true; }, expectedDuration);

    const consume = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (stream === 'stdout') ({ value: stdout, truncated: outputTruncated } = appendBounded(stdout, text, outputTruncated));
      else ({ value: stderr, truncated: outputTruncated } = appendBounded(stderr, text, outputTruncated));
      progressTail = `${progressTail}${text}`.slice(-8_192);
      const progress = parseDfuTransferProgress(progressTail);
      const key = progress ? `${progress.operation}:${progress.percent}` : '';
      if (progress && key !== lastProgress) { lastProgress = key; onProgress(progress); }
    };

    child.stdout.on('data', (chunk: Buffer) => consume('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => consume('stderr', chunk));
    child.stdout.on('error', (error: Error) => { observationFaults.push(`stdout: ${bounded(message(error))}`); });
    child.stderr.on('error', (error: Error) => { observationFaults.push(`stderr: ${bounded(message(error))}`); });
    child.once('error', (error) => {
      clearTimeout(durationTimer);
      reject(new Error(`${file} ${args.join(' ')} could not start: ${message(error)}`, { cause: error }));
    });
    child.once('close', (code, signal) => {
      clearTimeout(durationTimer);
      if (code !== 0) {
        reject(new Error(`${file} ${args.join(' ')} failed with code ${String(code)} signal ${signal ?? 'none'}: ${bounded(stderr || stdout)}`));
        return;
      }
      if (observationFaults.length) {
        reject(new Error(`${file} ${args.join(' ')} exited after an output-observation fault; write completion is indeterminate: ${observationFaults.join('; ')}`));
        return;
      }
      resolve({ stdout, stderr, outputTruncated, exceededExpectedDuration });
    });
    // Deliberately no timeout kill and no output-cap kill: once dfu-util may
    // have started writing, terminating observation could turn a slow write
    // into a host-created interruption. We retain bounded output and wait for
    // the child to report its actual exit.
  });
}

function appendBounded(existing: string, addition: string, alreadyTruncated: boolean): { value: string; truncated: boolean } {
  const combined = existing + addition;
  if (Buffer.byteLength(combined) <= DFU_OBSERVATION_LIMIT) return { value: combined, truncated: alreadyTruncated };
  return { value: combined.slice(-Math.floor(DFU_OBSERVATION_LIMIT / 2)), truncated: true };
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

interface LockRecord { purpose: LockPurpose; ownerToken: string; }

async function readLockRecord(path: string): Promise<LockRecord> {
  const bytes = new Uint8Array(await readFile(path));
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('lock must be a JSON object');
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) throw new Error('lock schemaVersion must be 1');
  if (record.purpose !== 'firmware-write' && record.purpose !== 'journal-mutation') throw new Error('lock purpose is invalid');
  if (typeof record.ownerToken !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.ownerToken)) {
    throw new Error('lock ownerToken is not a version-4 UUID');
  }
  if (typeof record.acquiredAt !== 'string' || !Number.isFinite(Date.parse(record.acquiredAt))) throw new Error('lock acquiredAt is invalid');
  return { purpose: record.purpose, ownerToken: record.ownerToken };
}

function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function isFileMissing(value: unknown): boolean { return hasCode(value, 'ENOENT'); }
function hasCode(value: unknown, code: string): boolean { return Boolean(value && typeof value === 'object' && 'code' in value && value.code === code); }
function bounded(value: string): string { return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 20_000); }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

const DEFAULT_RUNTIME: FirmwareUpdaterRuntime = {
  fetch: (url, init) => globalThis.fetch(url, init),
  locateDfuUtility,
  runExecutable,
  runDfuExecutable,
  verifyArtifact: verifyFirmwareArtifact,
  delay,
  beforeWriteLockAcquire: async () => undefined,
};

class NonOwnedSessionError extends Error {
  override readonly name = 'NonOwnedSessionError';
}
