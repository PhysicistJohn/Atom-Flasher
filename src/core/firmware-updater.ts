import { createHash, randomUUID } from 'node:crypto';
import {
  OEM_ZS407_FIRMWARE_TARGET,
  TINYSA_USB_PRODUCT_ID,
  TINYSA_USB_VENDOR_ID,
  deviceDiagnosticsSchema,
  deviceSnapshotSchema,
  firmwareFlashRequestSchema,
  firmwareUpdatePreflightSchema,
  firmwareUpdateStateSchema,
  localCustomFirmwareTargetSchema,
  initialFirmwareUpdateState,
  lookupSupportedZs407OemFirmware,
  portCandidateSchema,
  screenFrameSchema,
  uuidSchema,
  type DeviceDiagnostics,
  type DeviceSnapshot,
  type FirmwareFlashRequest,
  type FirmwareUpdatePreflight,
  type FirmwareUpdateState,
  type LocalCustomFirmwareTarget,
  type PortCandidate,
  type ScreenFrame,
} from './contracts.js';
import {
  FirmwareArtifactStore,
  readResponseBodyBounded,
  verifyFirmwareArtifact,
  type VerifiedFirmwareArtifact,
} from './firmware-artifact.js';
import {
  exactOneDfuIdentity,
  dfuExecutionResultSchema,
  dfuTransferProgressSchema,
  dfuUtilityPathSchema,
  executableResultSchema,
  hasExactDfuDownloadConfirmation,
  inheritedDfuFirmwarePath,
  inspectInternalFlashDescriptor,
  inspectStm32DfuDevices,
  locateDfuUtility,
  observeDfuExecution,
  parseDfuTransferProgress,
  parseDfuUtilVersion,
  runDfuExecutable,
  runExecutable,
  type DfuExecutionResult,
  type DfuToolRuntime,
  type DfuTransferProgress,
} from '../dfu/dfu-util.js';
import { firmwareTargetV2Sha256, preflightRecordV2Schema } from './persistence/evidence-schemas-v2.js';
import {
  FirmwareTransactionStore,
  TransactionOwnershipError,
  type FirmwareTransactionStoreTestHooks,
  type FirmwareWriteSession,
} from './persistence/firmware-transaction-store.js';

const MINIMUM_UPDATE_BATTERY_MV = 4_000;

export interface FirmwareUpdateSnapshotPort {
  snapshot(): DeviceSnapshot;
}

export interface FirmwareUpdateDiagnosticsPort {
  readDiagnostics(): Promise<DeviceDiagnostics>;
}

export interface FirmwareUpdateScreenCapturePort {
  captureScreen(): Promise<ScreenFrame>;
}

export interface FirmwareUpdateObservationPort
  extends FirmwareUpdateSnapshotPort, FirmwareUpdateDiagnosticsPort, FirmwareUpdateScreenCapturePort {}

export interface FirmwareUpdateDisconnectPort {
  disconnect(): Promise<void>;
}

export interface FirmwareUpdateDiscoveryPort {
  listDevices(): Promise<PortCandidate[]>;
}

export interface FirmwareUpdateConnectPort {
  connect(candidate: PortCandidate): Promise<DeviceSnapshot>;
}

export interface FirmwareUpdateConnectionPort
  extends FirmwareUpdateDisconnectPort, FirmwareUpdateDiscoveryPort, FirmwareUpdateConnectPort {}

export interface FirmwareUpdateDevice extends FirmwareUpdateObservationPort, FirmwareUpdateConnectionPort {}

export interface FirmwareArtifactFetchPort {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

export interface FirmwareArtifactVerificationPort {
  verifyArtifact(bytes: Uint8Array): void;
}

export interface FirmwareArtifactPort
  extends FirmwareArtifactFetchPort, FirmwareArtifactVerificationPort {}

export interface FirmwareClockPort {
  now(): Date;
}

export interface FirmwareIdentityPort {
  randomUuid(): string;
}

export interface FirmwareDelayPort {
  delay(milliseconds: number): Promise<void>;
}

export interface FirmwareTimeAndIdentityPort
  extends FirmwareClockPort, FirmwareIdentityPort, FirmwareDelayPort {}

export interface FirmwareUpdaterRuntime
  extends FirmwareArtifactPort, FirmwareTimeAndIdentityPort, DfuToolRuntime {}

export type FirmwareUpdaterTestHooks = FirmwareTransactionStoreTestHooks;

/**
 * Capability for an already admitted, app-owned artifact. The implementation
 * must open and verify the exact regular-file descriptor on every call. No
 * firmware pathname crosses into the dfu-util invocation.
 */
export interface AdmittedFirmwareArtifact {
  readonly targetId: string;
  openVerified(): Promise<VerifiedFirmwareArtifact>;
}

export class FirmwareUpdater {
  readonly #artifactStore: FirmwareArtifactStore;
  readonly #oemArtifact: AdmittedFirmwareArtifact;
  readonly #transactionStore: FirmwareTransactionStore;
  #admittedArtifact: AdmittedFirmwareArtifact | undefined;
  #dfuUtilityPath: string | undefined;
  #dfuInspection: Promise<void> | undefined;
  #dfuInspectedAt = 0;
  #journalRecovery: Promise<void> | undefined;
  #journalRecovered = false;
  #activeCommand: string | undefined;
  #state: FirmwareUpdateState = initialFirmwareUpdateState();
  readonly #runtime: FirmwareUpdaterRuntime;

  constructor(
    cacheDirectory: string,
    private readonly device: FirmwareUpdateDevice,
    runtime: Partial<FirmwareUpdaterRuntime> = {},
    testHooks: FirmwareUpdaterTestHooks = {},
  ) {
    this.#runtime = { ...DEFAULT_RUNTIME, ...runtime };
    this.#artifactStore = new FirmwareArtifactStore(cacheDirectory, {
      fetch: this.#runtime.fetch,
      verify: this.#runtime.verifyArtifact,
      now: () => this.#runtime.now(),
      randomUuid: () => this.#runtime.randomUuid(),
    });
    this.#oemArtifact = Object.freeze({
      targetId: OEM_ZS407_FIRMWARE_TARGET.targetId,
      openVerified: () => this.#artifactStore.openVerified(),
    });
    this.#transactionStore = new FirmwareTransactionStore(cacheDirectory, {
      now: () => this.#runtime.now(),
      randomUuid: () => this.#runtime.randomUuid(),
    }, testHooks);
  }

  async state(): Promise<FirmwareUpdateState> {
    return this.#runExclusive('recover-state', () => this.#readState());
  }

  async #readState(): Promise<FirmwareUpdateState> {
    await this.#loadJournal();
    this.#synchronizeDevice();
    if (this.#state.phase === 'available' && !this.#state.artifact) await this.#inspectCachedArtifact();
    if (!['flashing', 'reconnecting'].includes(this.#state.phase)) await this.#inspectDfuUtility();
    return this.#validatedSnapshot();
  }

  snapshot(): FirmwareUpdateState {
    if (!this.#journalRecovered) throw new Error('Firmware updater has not completed initial state recovery');
    return this.#validatedSnapshot();
  }

  async refreshPrerequisites(): Promise<FirmwareUpdateState> {
    return this.#runExclusive('refresh-prerequisites', () => this.#refreshPrerequisites());
  }

  async selectOemTarget(): Promise<FirmwareUpdateState> {
    return this.#runExclusive('select-oem-target', async () => {
      await this.#loadJournal();
      this.#requireWriteNotStarted();
      if (this.#state.preparation) throw new Error('A prepared firmware transaction cannot be retargeted');
      this.#admittedArtifact = this.#oemArtifact;
      this.#state = {
        ...initialFirmwareUpdateState(OEM_ZS407_FIRMWARE_TARGET),
        dfuUtility: this.#state.dfuUtility,
      };
      this.#synchronizeDevice();
      if (this.#state.phase === 'available') await this.#inspectCachedArtifact();
      return this.#validatedSnapshot();
    });
  }

  async admitLocalCustomTarget(
    targetValue: LocalCustomFirmwareTarget,
    artifact: AdmittedFirmwareArtifact,
  ): Promise<FirmwareUpdateState> {
    return this.#runExclusive('admit-local-custom-target', async () => {
      await this.#loadJournal();
      this.#requireWriteNotStarted();
      const target = localCustomFirmwareTargetSchema.parse(targetValue);
      await verifyAdmittedArtifact(target, artifact);

      if (this.#state.preparation) {
        if (this.#state.target.kind !== 'local-custom'
          || firmwareTargetV2Sha256(this.#state.target) !== firmwareTargetV2Sha256(target)
          || this.#state.artifact?.targetId !== target.targetId
          || this.#state.artifact.sha256 !== target.sha256
          || this.#state.artifact.sizeBytes !== target.sizeBytes) {
          throw new Error('A prepared transaction can only rebind its exact previously admitted custom artifact');
        }
        const reboundState = firmwareUpdateStateSchema.parse({
          ...this.#state,
          phase: 'awaiting-dfu',
          dfuDevice: { detected: false, count: 0 },
          error: undefined,
        });
        await this.#transactionStore.persist(reboundState);
        this.#admittedArtifact = artifact;
        this.#state = reboundState;
        return this.#validatedSnapshot();
      }

      const snapshot = deviceSnapshotSchema.parse(this.device.snapshot());
      if (snapshot.connection !== 'ready' || !snapshot.identity?.usbIdentityVerified) {
        throw new Error('Custom target admission requires one connected, exactly verified physical ZS407');
      }
      this.#admittedArtifact = artifact;
      this.#state = {
        ...initialFirmwareUpdateState(target),
        artifact: {
          targetId: target.targetId,
          sizeBytes: target.sizeBytes,
          sha256: target.sha256,
          verifiedAt: this.#nowIso(),
        },
        dfuUtility: this.#state.dfuUtility,
      };
      this.#synchronizeDevice();
      return this.#validatedSnapshot();
    });
  }

  async #refreshPrerequisites(): Promise<FirmwareUpdateState> {
    await this.#loadJournal();
    this.#requireWriteNotStarted();
    if (!this.#state.preparation || !['awaiting-dfu', 'ready-to-flash', 'failed'].includes(this.#state.phase)) {
      throw new Error(`DFU prerequisite refresh is not legal from ${this.#state.phase} state`);
    }
    if (this.#state.target.kind === 'local-custom') this.#requireAdmittedArtifact();
    await this.#inspectDfuUtility(true);
    return this.#validatedSnapshot();
  }

  async download(): Promise<FirmwareUpdateState> {
    return this.#runExclusive('download', () => this.#download());
  }

  async #download(): Promise<FirmwareUpdateState> {
    await this.#loadJournal();
    this.#requireWriteNotStarted();
    if (this.#state.preparation || !['available', 'failed'].includes(this.#state.phase)) {
      throw new Error(`Firmware download is not legal from ${this.#state.phase} state`);
    }
    if (this.#state.target.kind !== 'oem') throw new Error('Local custom firmware is admitted from app-owned storage and cannot be downloaded');
    this.#requireDifferentPhysicalDevice();
    this.#state = { ...this.#state, phase: 'downloading', error: undefined, artifact: undefined };
    try {
      const artifact = await this.#artifactStore.download();
      this.#admittedArtifact = this.#oemArtifact;
      this.#state = {
        ...this.#state,
        phase: 'verified',
        artifact: { ...artifact, targetId: this.#state.target.targetId },
        error: undefined,
      };
      return this.#validatedSnapshot();
    } catch (value) {
      throw await this.#fail(`Firmware download verification failed: ${message(value)}`);
    }
  }

  async prepare(input: FirmwareUpdatePreflight): Promise<FirmwareUpdateState> {
    return this.#runExclusive('prepare', () => this.#prepare(input));
  }

  async #prepare(input: FirmwareUpdatePreflight): Promise<FirmwareUpdateState> {
    await this.#loadJournal();
    this.#requireWriteNotStarted();
    if (this.#state.phase !== 'verified' || this.#state.preparation) {
      throw new Error(`Firmware preflight is not legal from ${this.#state.phase} state`);
    }
    const preflight = firmwareUpdatePreflightSchema.parse(input);
    this.#requireDifferentPhysicalDevice();
    if (this.#state.phase !== 'verified' || !this.#state.artifact) throw new Error('The exact selected firmware artifact must be admitted and verified before preparation');
    try {
      await this.#readVerifiedTargetArtifact();
      const diagnostics = deviceDiagnosticsSchema.parse(await this.device.readDiagnostics());
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
      const screen = screenFrameSchema.parse(await this.device.captureScreen());
      const preparation = {
        id: this.#randomUuid(),
        preparedAt: this.#nowIso(),
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
      const observedIdentity = { ...diagnostics.identity };
      Reflect.deleteProperty(observedIdentity, 'firmwareSourceCommit');
      const preflightRecord = preflightRecordV2Schema.parse({
        schemaVersion: 2,
        target: this.#state.target,
        targetSha256: firmwareTargetV2Sha256(this.#state.target),
        preparation,
        identity: observedIdentity,
        firmwareVersionResponse: diagnostics.firmwareVersionResponse,
        infoLines: diagnostics.infoLines,
        commands: diagnostics.commands,
        telemetry: diagnostics.telemetry,
        artifact: this.#state.artifact,
      });
      this.#state = {
        ...this.#state,
        phase: 'awaiting-dfu',
        preparation,
        dfuDevice: { detected: false, count: 0 },
        continuityWarning: 'USB CDC and STM32 DFU do not expose a publicly proven common identifier. TinySA Flasher records both identities, requires one exact DFU target, requires the only-USB-device attestation, and verifies the CDC device ID and serial after reboot; it does not claim cross-mode identity equivalence.',
        error: undefined,
      };
      await this.#transactionStore.recordPreflightAndPersist(preflightRecord, this.#state);
      await this.device.disconnect();
      return this.#validatedSnapshot();
    } catch (value) {
      throw await this.#fail(`Firmware preflight failed: ${message(value)}`);
    }
  }

  async detectDfu(): Promise<FirmwareUpdateState> {
    return this.#runExclusive('detect-dfu', () => this.#detectDfu());
  }

  async #detectDfu(): Promise<FirmwareUpdateState> {
    await this.#loadJournal();
    this.#requireWriteNotStarted();
    if (!['awaiting-dfu', 'ready-to-flash'].includes(this.#state.phase)
      && !(this.#state.phase === 'failed' && this.#state.preparation && this.#state.artifact)) {
      throw new Error(`DFU detection is not legal from ${this.#state.phase} state`);
    }
    if (!this.#state.preparation) throw new Error('Firmware update has no completed preflight record');
    if (this.#state.target.kind === 'local-custom') this.#requireAdmittedArtifact();
    try {
      const utility = await this.#requireDfuUtility();
      const listing = executableResultSchema.parse(await this.#runtime.runExecutable(utility, ['-l'], 15_000));
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
      await this.#transactionStore.persist(this.#state);
      return this.#validatedSnapshot();
    } catch (value) {
      throw await this.#fail(`DFU detection failed: ${message(value)}`);
    }
  }

  async flash(input: FirmwareFlashRequest): Promise<FirmwareUpdateState> {
    return this.#runExclusive('flash', () => this.#flash(input));
  }

  async #flash(input: FirmwareFlashRequest): Promise<FirmwareUpdateState> {
    await this.#loadJournal();
    this.#requireWriteNotStarted();
    if (this.#state.phase !== 'ready-to-flash') {
      throw new Error(`Firmware flash is not legal from ${this.#state.phase} state`);
    }
    const request = firmwareFlashRequestSchema.parse(input);
    const requiredConfirmation = this.#state.target.kind === 'oem'
      ? 'FLASH VERIFIED OEM FIRMWARE'
      : 'FLASH VERIFIED CUSTOM FIRMWARE';
    if (request.confirmation !== requiredConfirmation) {
      throw new Error(`Firmware confirmation must be exactly ${requiredConfirmation} for the selected target`);
    }
    const preparation = this.#state.preparation;
    const detectedIdentity = this.#state.dfuDevice.identity;
    if (!preparation || preparation.id !== request.preparationId) throw new Error('Firmware flash preparation token does not match');
    if (this.#state.phase !== 'ready-to-flash' || !this.#state.dfuDevice.detected || this.#state.dfuDevice.count !== 1 || !detectedIdentity) {
      throw new Error('Exactly one persisted STM32 DFU internal-flash target is required before flashing');
    }

    let writeSession: FirmwareWriteSession | undefined;
    let sessionArchived = false;
    let writeBoundaryPersisted = false;
    try {
      // Reject unsupported descriptor inheritance before acquiring the shared
      // write lock or recording a write attempt.
      inheritedDfuFirmwarePath();
      const utility = await this.#requireDfuUtility();
      await this.#readVerifiedTargetArtifact();

      // Close the detection-to-write race: enumerate again and require the same
      // canonical target identity before creating any write-attempt evidence.
      const listing = executableResultSchema.parse(await this.#runtime.runExecutable(utility, ['-l'], 15_000));
      const immediate = exactOneDfuIdentity(inspectStm32DfuDevices(`${listing.stdout}\n${listing.stderr}`));
      if (!immediate || immediate.fingerprint !== detectedIdentity.fingerprint) {
        throw new Error('DFU target identity changed after detection; no write was attempted');
      }
      const flashGeometry = inspectInternalFlashDescriptor(immediate.name);
      if (flashGeometry.capacityBytes < this.#state.target.sizeBytes) {
        throw new Error(`DFU internal flash has ${flashGeometry.capacityBytes} bytes, smaller than selected target ${this.#state.target.sizeBytes}`);
      }

      writeSession = await this.#transactionStore.acquireWriteSession(preparation.id, immediate);
      const writeStartedAt = this.#nowIso();
      const flashingState: FirmwareUpdateState = {
        ...this.#state,
        phase: 'flashing',
        writeDisposition: 'started',
        writeStartedAt,
        flashProgress: { stage: 'preparing', percent: 0, updatedAt: writeStartedAt },
        error: undefined,
      };
      await writeSession.admitWrite(flashingState);
      this.#state = flashingState;
      writeBoundaryPersisted = true;
      await writeSession.writeAudit('write-started', { preparationId: preparation.id, writeStartedAt, dfuIdentity: immediate });

      const verifiedArtifact = await this.#openVerifiedTargetArtifact();
      let transfer: DfuExecutionResult | undefined;
      let transferFailure: unknown;
      let transferFailed = false;
      try {
        // Artifact hashing can take materially longer than the adjacent fstat.
        // Open and hash first, then close the USB identity race with one final
        // enumeration. The final fstat and spawn follow immediately. The same
        // open description is inherited as child fd 3 until child exit.
        const finalListing = executableResultSchema.parse(await this.#runtime.runExecutable(utility, ['-l'], 15_000));
        const finalIdentity = exactOneDfuIdentity(inspectStm32DfuDevices(`${finalListing.stdout}\n${finalListing.stderr}`));
        if (!finalIdentity || finalIdentity.fingerprint !== immediate.fingerprint) {
          throw new Error('DFU target identity changed after durable write admission; no child process was started and the transaction remains locked for inspection');
        }
        const finalGeometry = inspectInternalFlashDescriptor(finalIdentity.name);
        if (finalGeometry.capacityBytes < this.#state.target.sizeBytes) {
          throw new Error(`Final DFU internal flash has ${finalGeometry.capacityBytes} bytes, smaller than selected target ${this.#state.target.sizeBytes}`);
        }
        await verifiedArtifact.assertStable();
        transfer = dfuExecutionResultSchema.parse(await this.#runtime.runDfuExecutable(
          utility,
          ['-d', '0483:df11', '-p', finalIdentity.path, '-S', finalIdentity.serial, '-a', '0', '-s', '0x08000000:leave'],
          120_000,
          (rawProgress) => {
            const progress = dfuTransferProgressSchema.parse(rawProgress);
            const stage = progress.operation === 'erase' ? 'erasing' : 'writing';
            const percent = progress.operation === 'erase' ? Math.round(progress.percent * 0.4) : 40 + Math.round(progress.percent * 0.55);
            this.#state = { ...this.#state, flashProgress: { stage, percent, stagePercent: progress.percent, updatedAt: this.#nowIso() } };
          },
          { descriptor: verifiedArtifact.descriptor },
        ));
      } catch (value) {
        transferFailed = true;
        transferFailure = value;
      }
      try {
        await verifiedArtifact.close();
      } catch (closeFailure) {
        if (transferFailed) {
          throw new Error(`dfu-util failed and the verified firmware descriptor also failed to close: ${message(transferFailure)}. Close failure: ${message(closeFailure)}`, { cause: transferFailure });
        }
        throw new Error(`dfu-util exited, but the verified firmware descriptor failed to close: ${message(closeFailure)}`, { cause: closeFailure });
      }
      if (transferFailed) throw transferFailure;
      if (!transfer) throw new Error('dfu-util returned no observable transfer result');
      const output = `${transfer.stdout}\n${transfer.stderr}`;
      if (!hasExactDfuDownloadConfirmation(output)) {
        throw new Error('dfu-util exited without its successful-download confirmation set');
      }
      const writeCompletedAt = this.#nowIso();
      this.#state = {
        ...this.#state,
        phase: 'reconnecting',
        writeDisposition: 'completed',
        writeCompletedAt,
        flashProgress: { stage: 'verifying-reboot', percent: 98, stagePercent: 100, updatedAt: writeCompletedAt },
      };
      await writeSession.persist(this.#state);
      await writeSession.writeAudit('write-complete', {
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
      const connectedValue = await this.device.connect(candidate);
      let connected: DeviceSnapshot;
      try { connected = deviceSnapshotSchema.parse(connectedValue); }
      catch (value) {
        await this.#disconnectAfterMismatch();
        throw new Error(`Post-flash identity is invalid: ${message(value)}`, { cause: value });
      }
      if (connected.connection !== 'ready') {
        await this.#disconnectAfterMismatch();
        throw new Error(`Post-flash device did not reach an admitted ready state: ${connected.connection}`);
      }
      if (connected.telemetry?.deviceId !== preparation.deviceId) {
        await this.#disconnectAfterMismatch();
        throw new Error(`Post-reboot device ID ${String(connected.telemetry?.deviceId ?? 'missing')} does not match preflight ID ${preparation.deviceId}`);
      }
      const expectedQualification = this.#state.target.kind === 'oem' ? 'supported-oem' : 'custom-unqualified';
      if (connected.identity?.firmwareVersion !== this.#state.target.version
        || connected.identity.firmwareQualification !== expectedQualification
        || connected.identity.firmwareReportedRevision !== this.#state.target.revision) {
        const identityError = `Post-flash identity is ${connected.identity?.firmwareVersion ?? 'missing'} (${connected.identity?.firmwareReportedRevision ?? 'missing'}), expected ${this.#state.target.version} (${this.#state.target.revision})`;
        await this.#disconnectAfterMismatch();
        throw new Error(identityError);
      }
      const completedAt = this.#nowIso();
      const verifiedCurrent: NonNullable<FirmwareUpdateState['current']> = expectedQualification === 'custom-unqualified'
        ? {
          version: connected.identity.firmwareVersion,
          revision: connected.identity.firmwareReportedRevision,
          qualification: 'custom-unqualified',
        }
        : {
          version: OEM_ZS407_FIRMWARE_TARGET.version,
          revision: OEM_ZS407_FIRMWARE_TARGET.revision,
          qualification: 'supported-oem',
        };
      this.#state = {
        ...this.#state,
        phase: 'completed',
        targetRelation: 'same',
        updateAvailable: false,
        current: verifiedCurrent,
        flashProgress: { stage: 'complete', percent: 100, stagePercent: 100, updatedAt: completedAt },
        completedAt,
        error: undefined,
      };
      await writeSession.writeAudit('verified-complete', {
        preparationId: preparation.id,
        writeCompletedAt,
        completedAt,
        identity: (() => {
          const observedIdentity = { ...connected.identity };
          Reflect.deleteProperty(observedIdentity, 'firmwareSourceCommit');
          return {
          ...observedIdentity,
          firmwareVersion: this.#state.target.version,
          firmwareReportedRevision: this.#state.target.revision,
          firmwareQualification: expectedQualification,
          port: {
            ...connected.identity.port,
            vendorId: TINYSA_USB_VENDOR_ID,
            productId: TINYSA_USB_PRODUCT_ID,
            usbMatch: 'exact-zs407-cdc',
          },
          };
        })(),
        deviceId: connected.telemetry.deviceId,
      });
      await writeSession.persist(this.#state);

      await writeSession.archiveCompleted(this.#state);
      sessionArchived = true;
      await writeSession.releaseAfterArchive();
      writeSession = undefined;
      return this.#validatedSnapshot();
    } catch (value) {
      if (sessionArchived || this.#transactionStore.completedSessionArchived) {
        const error = `Firmware completed and entered the immutable ledger, but its owner lock could not be released. Flashing remains manually locked: ${message(value)}`;
        this.#state = { ...this.#state, phase: 'failed', error };
        throw new Error(error, { cause: value });
      }
      if (writeSession && !writeBoundaryPersisted && !(value instanceof TransactionOwnershipError)) {
        try {
          await writeSession.releaseBeforeWrite();
          writeSession = undefined;
        } catch (cleanupFailure) {
          const error = `Firmware flash failed before durable write admission, and the newly acquired lock could not be safely released. Flashing remains manually locked: ${message(value)}. Lock cleanup failed: ${message(cleanupFailure)}`;
          this.#state = { ...this.#state, phase: 'failed', writeDisposition: 'indeterminate', error };
          throw new Error(error, { cause: cleanupFailure });
        }
      }
      if (value instanceof TransactionOwnershipError
        || (!writeSession && this.#state.writeDisposition === 'not-started' && await this.#transactionStore.writeLockExists())) {
        let cleanup = '';
        if (writeSession && !writeBoundaryPersisted) {
          try { await writeSession.releaseBeforeWrite(); }
          catch (cleanupFailure) { cleanup = ` Known-new lock cleanup failed and the lock was retained: ${message(cleanupFailure)}`; }
          writeSession = undefined;
        }
        const error = `A different or stale firmware session owns the shared write boundary. This process is permanently blocked and did not modify the shared journal: ${message(value)}${cleanup}`;
        this.#state = {
          ...this.#state,
          phase: 'failed',
          ...(this.#state.writeDisposition === 'not-started' ? { writeDisposition: 'indeterminate' as const } : {}),
          error,
        };
        throw new Error(error, { cause: value });
      }
      const prefix = this.#state.writeDisposition === 'not-started'
        ? 'Firmware flash failed before any write attempt began'
        : this.#state.writeDisposition === 'completed'
          ? 'Firmware write completed but post-flash verification failed; do not flash again'
          : 'Firmware write may have begun but completion is unverified; do not flash again';
      throw await this.#fail(`${prefix}: ${message(value)}`, writeSession);
    }
  }

  async #runExclusive<T>(name: string, operation: () => Promise<T>): Promise<T> {
    if (this.#activeCommand) {
      throw new Error(`Firmware updater command ${this.#activeCommand} is already active; ${name} was not started`);
    }
    this.#activeCommand = name;
    try { return await operation(); }
    finally { this.#activeCommand = undefined; }
  }

  #validatedSnapshot(): FirmwareUpdateState {
    this.#state = firmwareUpdateStateSchema.parse(this.#state);
    return structuredClone(this.#state);
  }

  #now(): Date {
    const value = this.#runtime.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('Firmware runtime clock returned an invalid Date');
    return new Date(value.getTime());
  }

  #nowIso(): string { return this.#now().toISOString(); }

  #randomUuid(): string { return uuidSchema.parse(this.#runtime.randomUuid()); }

  async #loadJournal(): Promise<void> {
    this.#journalRecovery ??= this.#recoverJournal().then(() => { this.#journalRecovered = true; });
    await this.#journalRecovery;
  }

  async #recoverJournal(): Promise<void> {
    try {
      const recovered = await this.#transactionStore.recover();
      if (recovered.blockingReason) {
        this.#state = {
          ...initialFirmwareUpdateState(),
          phase: 'failed',
          writeDisposition: 'indeterminate',
          error: recovered.blockingReason,
        };
        return;
      }
      if (!recovered.state) return;
      this.#state = recovered.state;
      this.#admittedArtifact = this.#state.target.kind === 'oem' && this.#state.artifact
        ? this.#oemArtifact
        : undefined;
      if (recovered.writeLockPresent) {
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
        try { await this.#transactionStore.archiveCompletedRecovery(this.#state); }
        catch (value) { this.#state = { ...this.#state, phase: 'failed', error: `Completed-session ledger recovery failed: ${message(value)}` }; }
        return;
      }
      if (this.#state.target.kind === 'local-custom' && this.#state.preparation) {
        this.#state = {
          ...this.#state,
          phase: 'failed',
          dfuDevice: { detected: false, count: 0 },
          error: 'The recovered prepared custom transaction has no in-process artifact capability. Re-admit the exact app-owned manifest before DFU detection or flashing.',
        };
      } else if (this.#state.target.kind === 'local-custom' && this.#state.artifact) {
        this.#state = {
          ...this.#state,
          phase: 'failed',
          error: 'The recovered custom target has no in-process artifact capability. Reconnect the exact ZS407 and re-select the manifest through the native picker before preparing a write.',
        };
      } else if (this.#state.phase === 'downloading') {
        this.#state = {
          ...this.#state,
          phase: 'failed',
          artifact: undefined,
          error: 'The previous TinySA Flasher process ended during firmware download. No artifact was admitted and no write began; retry the exact download.',
        };
      } else if (this.#state.phase === 'ready-to-flash') {
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
      try { await this.#transactionStore.persist(this.#state); }
      catch (value) { this.#state = { ...this.#state, error: `${this.#state.error ?? 'Recovered journal state.'} Recovery could not be persisted: ${message(value)}` }; }
    } catch (value) {
      this.#state = {
        ...initialFirmwareUpdateState(),
        phase: 'failed',
        writeDisposition: 'indeterminate',
        error: `Firmware safety evidence could not be inspected. Flashing is locked pending manual inspection: ${message(value)}`,
      };
    }
  }

  #requireWriteNotStarted(): void {
    if (this.#state.writeDisposition === 'not-started') return;
    if (this.#state.writeDisposition === 'indeterminate') throw new Error('Firmware journal integrity is indeterminate; flashing remains locked pending manual inspection');
    throw new Error('A firmware write attempt already began; TinySA Flasher will not issue another write');
  }

  #synchronizeDevice(): void {
    if (this.#state.preparation || ['downloading', 'flashing', 'reconnecting', 'completed'].includes(this.#state.phase)) return;
    const snapshot = deviceSnapshotSchema.parse(this.device.snapshot());
    const identity = snapshot.identity;
    if (snapshot.connection !== 'ready' || !identity || !identity.usbIdentityVerified) {
      if (this.#state.phase !== 'failed') this.#state = { ...initialFirmwareUpdateState(this.#state.target), dfuUtility: this.#state.dfuUtility };
      return;
    }
    let current: NonNullable<FirmwareUpdateState['current']>;
    if (identity.firmwareQualification === 'custom-unqualified') {
      current = {
        version: identity.firmwareVersion,
        revision: identity.firmwareReportedRevision,
        qualification: 'custom-unqualified',
      };
    } else {
      const supportedFirmware = lookupSupportedZs407OemFirmware(identity.firmwareVersion);
      if (!supportedFirmware || supportedFirmware.revision !== identity.firmwareReportedRevision) {
        throw new Error('Physical firmware identity has an inconsistent supported-OEM version/revision pair');
      }
      current = {
        ...(supportedFirmware.version === OEM_ZS407_FIRMWARE_TARGET.version
          ? { version: OEM_ZS407_FIRMWARE_TARGET.version, revision: OEM_ZS407_FIRMWARE_TARGET.revision }
          : { version: 'tinySA4_v1.4-217-gc5dd31f' as const, revision: 'c5dd31f' as const }),
        qualification: 'supported-oem' as const,
      };
    }
    const targetMatches = this.#state.target.kind === 'oem'
      && current.version === this.#state.target.version
      && current.revision === this.#state.target.revision
      && current.qualification === 'supported-oem';
    const targetRelation = targetMatches ? 'same' as const
      : current.qualification === 'custom-unqualified' ? 'custom-current' as const : 'different-supported' as const;
    const writeIntent = targetMatches ? undefined
      : this.#state.target.kind === 'local-custom' ? 'install-custom' as const
        : current.qualification === 'custom-unqualified' ? 'restore-oem' as const : 'update-oem' as const;
    const phase = this.#state.phase === 'failed' ? 'failed' as const
      : targetMatches ? 'up-to-date' as const
        : this.#state.artifact ? 'verified' as const : 'available' as const;
    this.#state = {
      ...this.#state,
      phase,
      current,
      targetRelation,
      ...(writeIntent ? { writeIntent } : { writeIntent: undefined }),
      updateAvailable: !targetMatches,
      warning: current.qualification === 'custom-unqualified' ? identity.firmwareWarning : undefined,
      error: phase === 'failed' ? this.#state.error : undefined,
    };
  }

  #requireDifferentPhysicalDevice(): void {
    this.#synchronizeDevice();
    const snapshot = deviceSnapshotSchema.parse(this.device.snapshot());
    if (snapshot.connection !== 'ready' || !snapshot.identity?.usbIdentityVerified) throw new Error('Firmware update requires one connected, exactly verified physical ZS407');
    if (this.#state.targetRelation === 'unknown' || this.#state.targetRelation === 'same' || !this.#state.writeIntent) {
      throw new Error('The connected ZS407 already runs the exact selected firmware target');
    }
  }

  async #inspectDfuUtility(force = false): Promise<void> {
    if (!force && this.#dfuInspectedAt && this.#now().getTime() - this.#dfuInspectedAt < 30_000) return;
    if (this.#dfuInspection) return this.#dfuInspection;
    this.#dfuInspection = this.#performDfuUtilityInspection();
    try { await this.#dfuInspection; }
    finally { this.#dfuInspection = undefined; }
  }

  async #performDfuUtilityInspection(): Promise<void> {
    let unavailable = false;
    let inspectionError: string | undefined;
    try {
      const locatedPath = await this.#runtime.locateDfuUtility();
      const path = locatedPath === undefined ? undefined : dfuUtilityPathSchema.parse(locatedPath);
      if (!path) unavailable = true;
      else {
        const result = executableResultSchema.parse(await this.#runtime.runExecutable(path, ['--version'], 10_000));
        const version = parseDfuUtilVersion(`${result.stdout}\n${result.stderr}`);
        this.#dfuUtilityPath = path;
        this.#state = { ...this.#state, dfuUtility: { available: true, version } };
      }
    } catch (value) {
      unavailable = true;
      inspectionError = `DFU utility inspection failed: ${message(value)}`;
    } finally {
      this.#dfuInspectedAt = this.#now().getTime();
    }
    if (unavailable) await this.#recordDfuUtilityUnavailable(inspectionError);
  }

  async #recordDfuUtilityUnavailable(error?: string): Promise<void> {
    this.#dfuUtilityPath = undefined;
    const wasReady = this.#state.phase === 'ready-to-flash';
    this.#state = {
      ...this.#state,
      ...(wasReady ? { phase: 'awaiting-dfu' as const, dfuDevice: { detected: false, count: 0 } } : {}),
      dfuUtility: { available: false },
      ...(error ? { error } : { error: undefined }),
    };
    if (wasReady) await this.#transactionStore.persist(this.#state);
  }

  async #inspectCachedArtifact(): Promise<void> {
    if (this.#state.target.kind !== 'oem') return;
    try {
      const artifact = await this.#artifactStore.inspect();
      if (!artifact) return;
      this.#admittedArtifact = this.#oemArtifact;
      this.#state = {
        ...this.#state,
        phase: 'verified',
        artifact: { ...artifact, targetId: this.#state.target.targetId },
        error: undefined,
      };
    } catch (value) {
      this.#state = { ...this.#state, phase: 'failed', error: `Cached firmware verification failed: ${message(value)}` };
    }
  }

  async #requireDfuUtility(): Promise<string> {
    await this.#inspectDfuUtility(true);
    if (!this.#dfuUtilityPath || !this.#state.dfuUtility.available) throw new Error('dfu-util 0.11 is unavailable; install the exact prerequisite before entering DFU mode');
    return this.#dfuUtilityPath;
  }

  #requireAdmittedArtifact(): AdmittedFirmwareArtifact {
    const artifact = this.#admittedArtifact;
    if (!artifact || artifact.targetId !== this.#state.target.targetId) {
      throw new Error('The selected target artifact capability is not bound in this process; re-admit the exact artifact before flashing');
    }
    if (typeof artifact.openVerified !== 'function') throw new Error('The admitted artifact descriptor capability is invalid');
    return artifact;
  }

  async #readVerifiedTargetArtifact(): Promise<Uint8Array> {
    const verified = await this.#openVerifiedTargetArtifact();
    let operationFailure: unknown;
    let operationFailed = false;
    let bytes: Uint8Array | undefined;
    try {
      await verified.assertStable();
      bytes = verified.bytes;
    } catch (value) {
      operationFailed = true;
      operationFailure = value;
    }
    try { await verified.close(); }
    catch (closeFailure) {
      if (operationFailed) {
        throw new Error(`Artifact verification failed and its descriptor also failed to close: ${message(operationFailure)}. Close failure: ${message(closeFailure)}`, { cause: operationFailure });
      }
      throw new Error(`Verified artifact descriptor failed to close: ${message(closeFailure)}`, { cause: closeFailure });
    }
    if (operationFailed) throw operationFailure;
    if (!bytes) throw new Error('Verified artifact bytes became unavailable');
    return bytes;
  }

  async #openVerifiedTargetArtifact(): Promise<VerifiedFirmwareArtifact> {
    const verified = await this.#requireAdmittedArtifact().openVerified();
    try {
      assertVerifiedArtifactShape(verified);
      const bytes = verified.bytes;
      if (bytes.byteLength !== this.#state.target.sizeBytes) {
        throw new Error(`Admitted artifact has ${bytes.byteLength} bytes, expected ${this.#state.target.sizeBytes}`);
      }
      if (this.#state.target.kind === 'local-custom') {
        const actual = sha256(bytes);
        if (actual !== this.#state.target.sha256) {
          throw new Error(`Admitted artifact SHA-256 ${actual} does not match selected target ${this.#state.target.sha256}`);
        }
      }
      return verified;
    } catch (value) {
      try { await verified?.close?.(); }
      catch (closeFailure) {
        throw new Error(`Admitted artifact validation failed and its descriptor also failed to close: ${message(value)}. Close failure: ${message(closeFailure)}`, { cause: value });
      }
      throw value;
    }
  }

  async #waitForOnePhysicalDevice(preflightSerial?: string): Promise<PortCandidate> {
    for (let attempt = 0; attempt < 30; attempt++) {
      const exact = (await this.device.listDevices()).map((candidate) => portCandidateSchema.parse(candidate))
        .filter((candidate) => candidate.usbMatch === 'exact-zs407-cdc');
      if (exact.length > 1) throw new Error(`Post-flash discovery found ${exact.length} exact ZS407 candidates`);
      if (preflightSerial) {
        const matched = exact.filter((candidate) => candidate.serialNumber === preflightSerial);
        if (matched[0]) return matched[0];
        if (exact.length) throw new Error('A ZS407 returned after flash, but its CDC serial does not match preflight');
      } else {
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

  async #fail(error: string, writeSession?: FirmwareWriteSession): Promise<Error> {
    this.#state = { ...this.#state, phase: 'failed', error };
    if (this.#state.preparation || this.#state.writeDisposition !== 'not-started') {
      try {
        if (writeSession) await writeSession.persist(this.#state);
        else await this.#transactionStore.persist(this.#state);
      }
      catch (value) {
        const lostOwnership = value instanceof TransactionOwnershipError;
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

export {
  exactOneDfuIdentity,
  inspectInternalFlashDescriptor,
  inspectStm32DfuDevices,
  locateDfuUtility,
  observeDfuExecution,
  parseDfuTransferProgress,
  parseDfuUtilVersion,
  readResponseBodyBounded,
  verifyFirmwareArtifact,
};
export type { DfuExecutionResult, DfuTransferProgress };

function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
async function verifyAdmittedArtifact(target: LocalCustomFirmwareTarget, artifact: AdmittedFirmwareArtifact): Promise<void> {
  if (artifact.targetId !== target.targetId) throw new Error('Admitted artifact target ID does not match the custom manifest');
  if (typeof artifact.openVerified !== 'function') throw new Error('Admitted custom artifact descriptor capability is invalid');
  const verified = await artifact.openVerified();
  let verificationFailure: unknown;
  let verificationFailed = false;
  try {
    assertVerifiedArtifactShape(verified);
    if (verified.bytes.byteLength !== target.sizeBytes) {
      throw new Error(`Admitted custom artifact has ${verified.bytes.byteLength} bytes, expected ${target.sizeBytes}`);
    }
    const actual = sha256(verified.bytes);
    if (actual !== target.sha256) throw new Error(`Admitted custom artifact SHA-256 ${actual} does not match manifest ${target.sha256}`);
    await verified.assertStable();
  } catch (value) {
    verificationFailed = true;
    verificationFailure = value;
  }
  try { await verified?.close?.(); }
  catch (closeFailure) {
    if (verificationFailed) {
      throw new Error(`Custom artifact verification failed and its descriptor also failed to close: ${message(verificationFailure)}. Close failure: ${message(closeFailure)}`, { cause: verificationFailure });
    }
    throw new Error(`Verified custom artifact descriptor failed to close: ${message(closeFailure)}`, { cause: closeFailure });
  }
  if (verificationFailed) throw verificationFailure;
}
function assertVerifiedArtifactShape(value: unknown): asserts value is VerifiedFirmwareArtifact {
  if (!value || typeof value !== 'object') throw new Error('Admitted artifact opener did not return a descriptor capability');
  const candidate = value as Partial<VerifiedFirmwareArtifact>;
  if (!Number.isSafeInteger(candidate.descriptor) || (candidate.descriptor ?? -1) <= 2) {
    throw new Error('Admitted artifact opener returned an invalid non-stdio descriptor');
  }
  if (!(candidate.bytes instanceof Uint8Array)) throw new Error('Admitted artifact opener did not return verified bytes');
  if (typeof candidate.assertStable !== 'function' || typeof candidate.close !== 'function') {
    throw new Error('Admitted artifact opener returned an incomplete descriptor capability');
  }
}
function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function bounded(value: string): string { return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 20_000); }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

const DEFAULT_RUNTIME: FirmwareUpdaterRuntime = {
  fetch: (url, init) => globalThis.fetch(url, init),
  locateDfuUtility,
  runExecutable,
  runDfuExecutable,
  verifyArtifact: verifyFirmwareArtifact,
  now: () => new Date(),
  randomUuid: () => randomUUID(),
  delay,
};
