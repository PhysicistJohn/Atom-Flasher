import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  firmwareUpdatePreflightSchema,
  isoTimestampSchema,
  portCandidateSchema,
  uuidSchema,
  type DeviceSnapshot,
  type FirmwareFlashRequest,
  type LocalCustomFirmwareTarget,
  type FirmwareUpdatePreflight,
  type FirmwareUpdateState,
  type PortCandidate,
} from '../core/contracts.js';
import { MANUAL_POWER_OFF_CONFIRMATION } from '../device/device-service.js';
import {
  applicationActionResultSchema,
  applicationSnapshotSchema,
  deriveAllowedActions,
  type ApplicationActionResult,
  type ApplicationActivity,
  type ApplicationOperation,
  type ApplicationSnapshot,
  type AllowedActions,
} from './application-contract.js';
import { OperationGate } from './operation-gate.js';
import type { AdmittedFirmwareArtifact } from '../core/firmware-updater.js';

export interface ApplicationDevicePort {
  listDevices(): Promise<PortCandidate[]>;
  snapshot(): DeviceSnapshot;
  connect(candidate: PortCandidate): Promise<DeviceSnapshot>;
  disconnect(): Promise<void>;
  recoverAfterManualPowerOff(confirmation: typeof MANUAL_POWER_OFF_CONFIRMATION): Promise<DeviceSnapshot>;
}

export interface ApplicationUpdaterPort {
  state(): Promise<FirmwareUpdateState>;
  snapshot(): FirmwareUpdateState;
  download(): Promise<FirmwareUpdateState>;
  prepare(input: FirmwareUpdatePreflight): Promise<FirmwareUpdateState>;
  detectDfu(): Promise<FirmwareUpdateState>;
  refreshPrerequisites(): Promise<FirmwareUpdateState>;
  flash(input: FirmwareFlashRequest): Promise<FirmwareUpdateState>;
  selectOemTarget(): Promise<FirmwareUpdateState>;
  admitLocalCustomTarget(target: LocalCustomFirmwareTarget, artifact: AdmittedFirmwareArtifact): Promise<FirmwareUpdateState>;
}

export interface NativeSafetyPromptPort {
  confirmFirmwareWrite(input: FirmwareWritePrompt): Promise<boolean>;
  confirmPhysicalPowerOff(): Promise<boolean>;
}

export interface LocalFirmwareTargetSelection {
  readonly target: LocalCustomFirmwareTarget;
  readonly artifact: AdmittedFirmwareArtifact;
}

/** Native-main capability; renderer-controlled paths never enter this port. */
export interface LocalFirmwareTargetPickerPort {
  selectLocalFirmwareTarget(): Promise<LocalFirmwareTargetSelection | undefined>;
}

export type FirmwareWritePrompt = {
  readonly preparationId: string;
  readonly targetId: string;
  readonly targetVersion: string;
  readonly targetSha256: string;
} & ({
  readonly targetKind: 'oem';
} | {
  readonly targetKind: 'local-custom';
  /** Full custom-manifest binding; targetId alone is only artifact-addressed. */
  readonly targetManifestSha256: string;
});

/** Injectable nondeterminism keeps the application policy independently testable. */
export interface ApplicationTimeAndIdentityPort {
  now(): Date;
  randomUuid(): string;
}

const defaultTimeAndIdentity: ApplicationTimeAndIdentityPort = Object.freeze({
  now: () => new Date(),
  randomUuid: () => randomUUID(),
});

const unavailableTargetPicker: LocalFirmwareTargetPickerPort = Object.freeze({
  selectLocalFirmwareTarget: () => Promise.reject(new Error('Local firmware target selection is unavailable')),
});

const allowedActionByOperation = Object.freeze({
  'scan-devices': 'scanDevices',
  'connect-device': 'connectDevice',
  'disconnect-device': 'disconnectDevice',
  'recover-device': 'recoverDevice',
  'select-oem-target': 'selectOemTarget',
  'select-local-firmware-target': 'selectLocalFirmwareTarget',
  'download-firmware': 'download',
  'prepare-firmware': 'prepare',
  'detect-dfu': 'detectDfu',
  'refresh-prerequisites': 'refreshPrerequisites',
  'flash-firmware': 'flash',
}) satisfies Readonly<Record<Exclude<ApplicationOperation, 'safe-disconnect'>, keyof AllowedActions>>;

export class FlasherApplication {
  readonly #instanceId: string;
  readonly #gate = new OperationGate();
  #releaseTail: Promise<void> | undefined;
  #sequence = 0;
  #initialized = false;
  #initialization: Promise<void> | undefined;
  #operation: ApplicationOperation | undefined;
  #criticalSection: ApplicationActivity['criticalSection'] = 'none';
  #admission: ApplicationActivity['admission'] = 'accepting';
  #candidates: readonly PortCandidate[] = [];
  #scannedAt: string | undefined;

  constructor(
    private readonly device: ApplicationDevicePort,
    private readonly updater: ApplicationUpdaterPort,
    private readonly prompts: NativeSafetyPromptPort,
    private readonly targetPicker: LocalFirmwareTargetPickerPort = unavailableTargetPicker,
    private readonly timeAndIdentity: ApplicationTimeAndIdentityPort = defaultTimeAndIdentity,
  ) {
    this.#instanceId = uuidSchema.parse(timeAndIdentity.randomUuid());
  }

  get criticalSection(): ApplicationActivity['criticalSection'] { return this.#criticalSection; }
  get admission(): ApplicationActivity['admission'] { return this.#admission; }
  get activeOperation(): ApplicationOperation | undefined { return this.#operation; }

  async initialize(): Promise<ApplicationSnapshot> {
    if (!this.#initialized) {
      this.#initialization ??= (async () => {
        await this.updater.state();
        this.#initialized = true;
      })();
      try { await this.#initialization; }
      catch (value) {
        this.#initialization = undefined;
        throw value;
      }
    }
    return this.snapshot();
  }

  snapshot(): ApplicationSnapshot {
    if (!this.#initialized) throw new Error('Flasher application has not completed initialization');
    const activity: ApplicationActivity = {
      ...(this.#operation ? { operation: this.#operation } : {}),
      criticalSection: this.#criticalSection,
      admission: this.#admission,
    };
    const device = this.device.snapshot();
    const update = this.updater.snapshot();
    return applicationSnapshotSchema.parse({
      schemaVersion: 2,
      instanceId: this.#instanceId,
      sequence: ++this.#sequence,
      capturedAt: this.#timestamp(),
      activity,
      discovery: {
        candidates: this.#candidates,
        ...(this.#scannedAt ? { scannedAt: this.#scannedAt } : {}),
      },
      device,
      update,
      allowedActions: deriveAllowedActions(device, update, activity),
    });
  }

  scanDevices(): Promise<ApplicationActionResult> {
    return this.#run('scan-devices', async () => {
      this.#candidates = (await this.device.listDevices()).map((candidate) => portCandidateSchema.parse(candidate));
      this.#scannedAt = this.#timestamp();
      return 'completed';
    });
  }

  connectDevice(candidate: PortCandidate): Promise<ApplicationActionResult> {
    return this.#run('connect-device', async () => {
      await this.device.connect(portCandidateSchema.parse(candidate));
      await this.updater.state();
      return 'completed';
    });
  }

  disconnectDevice(): Promise<ApplicationActionResult> {
    return this.#run('disconnect-device', async () => {
      await this.device.disconnect();
      await this.updater.state();
      return 'completed';
    });
  }

  recoverDevice(): Promise<ApplicationActionResult> {
    return this.#run('recover-device', async () => {
      this.#criticalSection = 'native-confirmation';
      try {
        if (!await this.prompts.confirmPhysicalPowerOff()) return 'cancelled';
        await this.device.recoverAfterManualPowerOff(MANUAL_POWER_OFF_CONFIRMATION);
        await this.updater.state();
        return 'completed';
      } finally {
        this.#criticalSection = 'none';
      }
    });
  }

  selectOemTarget(): Promise<ApplicationActionResult> {
    return this.#run('select-oem-target', async () => {
      await this.updater.selectOemTarget();
      return 'completed';
    });
  }

  selectLocalFirmwareTarget(): Promise<ApplicationActionResult> {
    return this.#run('select-local-firmware-target', async () => {
      this.#criticalSection = 'native-file-selection';
      try {
        const beforeSelection = this.updater.snapshot();
        const selection = await this.targetPicker.selectLocalFirmwareTarget();
        if (!selection) return 'cancelled';
        if (beforeSelection.preparation && !isDeepStrictEqual(selection.target, beforeSelection.target)) {
          throw new Error('A prepared firmware transaction can only re-admit its exact selected custom target');
        }
        await this.updater.admitLocalCustomTarget(selection.target, selection.artifact);
        return 'completed';
      } finally {
        this.#criticalSection = 'none';
      }
    });
  }

  download(): Promise<ApplicationActionResult> {
    return this.#run('download-firmware', async () => { await this.updater.download(); return 'completed'; });
  }

  prepare(input: FirmwareUpdatePreflight): Promise<ApplicationActionResult> {
    return this.#run('prepare-firmware', async () => {
      await this.updater.prepare(firmwareUpdatePreflightSchema.parse(input));
      return 'completed';
    });
  }

  detectDfu(): Promise<ApplicationActionResult> {
    return this.#run('detect-dfu', async () => { await this.updater.detectDfu(); return 'completed'; });
  }

  refreshPrerequisites(): Promise<ApplicationActionResult> {
    return this.#run('refresh-prerequisites', async () => { await this.updater.refreshPrerequisites(); return 'completed'; });
  }

  flash(preparationId: string): Promise<ApplicationActionResult> {
    return this.#run('flash-firmware', async () => {
      const state = this.updater.snapshot();
      if (state.phase !== 'ready-to-flash' || state.preparation?.id !== preparationId) {
        throw new Error('The flash request does not match the active ready preparation');
      }
      this.#criticalSection = 'native-confirmation';
      try {
        const prompt: FirmwareWritePrompt = state.target.kind === 'oem'
          ? {
            preparationId,
            targetId: state.target.targetId,
            targetKind: 'oem',
            targetVersion: state.target.version,
            targetSha256: state.target.sha256,
          }
          : {
            preparationId,
            targetId: state.target.targetId,
            targetKind: 'local-custom',
            targetVersion: state.target.version,
            targetSha256: state.target.sha256,
            targetManifestSha256: state.target.manifestSha256,
          };
        if (!await this.prompts.confirmFirmwareWrite(prompt)) {
          return 'cancelled';
        }
        this.#criticalSection = 'firmware-write-or-verification';
        const confirmation = state.target.kind === 'oem'
          ? 'FLASH VERIFIED OEM FIRMWARE' as const
          : 'FLASH VERIFIED CUSTOM FIRMWARE' as const;
        await this.updater.flash({ preparationId, confirmation });
        return 'completed';
      } finally {
        this.#criticalSection = 'none';
      }
    });
  }

  async requestShutdown(): Promise<'safe' | 'blocked-critical'> {
    return this.#enqueueRelease(true);
  }

  releaseForWindowClose(): Promise<'safe' | 'blocked-critical'> {
    return this.#enqueueRelease(false);
  }

  /** Reopens renderer admission only after the host has installed a new trusted window. */
  resumeAfterWindowOpen(): void {
    if (!this.#initialized) throw new Error('Flasher application has not completed initialization');
    if (this.#admission === 'closed') throw new Error('Application operation admission is permanently closed');
    if (this.#criticalSection !== 'none' || this.#gate.active) {
      throw new Error('Cannot reopen renderer admission while an application operation is active');
    }
    this.#admission = 'accepting';
  }

  #enqueueRelease(permanent: boolean): Promise<'safe' | 'blocked-critical'> {
    const prior = this.#releaseTail;
    // The first release starts synchronously so admission closes before another
    // renderer event can enter. Later lifecycle requests are serialized.
    const operation = prior
      ? prior.then(() => this.#releaseDevice(permanent))
      : this.#releaseDevice(permanent);
    const tail = operation.then(() => undefined, () => undefined);
    this.#releaseTail = tail;
    void tail.then(() => {
      if (this.#releaseTail === tail) this.#releaseTail = undefined;
    });
    return operation;
  }

  async #releaseDevice(permanent: boolean): Promise<'safe' | 'blocked-critical'> {
    if (this.#admission === 'closed') return 'safe';
    if (this.#criticalSection !== 'none') return 'blocked-critical';
    this.#admission = 'draining';
    try {
      await this.#gate.whenIdle();
      if (this.#criticalSection !== 'none') {
        this.#admission = 'accepting';
        return 'blocked-critical';
      }
      await this.#gate.run('safe-disconnect', async () => {
        this.#operation = 'safe-disconnect';
        try {
          if (this.device.snapshot().connection !== 'disconnected') await this.device.disconnect();
          await this.updater.state();
        } finally {
          this.#operation = undefined;
        }
      });
      // A successful window release stays draining until DesktopHost installs
      // a new trusted window and explicitly reopens admission.
      this.#admission = permanent ? 'closed' : 'draining';
      return 'safe';
    } catch (value) {
      this.#admission = 'accepting';
      throw value;
    }
  }

  async #run(
    operation: ApplicationOperation,
    action: () => Promise<ApplicationActionResult['outcome']>,
  ): Promise<ApplicationActionResult> {
    if (!this.#initialized) throw new Error('Flasher application has not completed initialization');
    if (this.#admission !== 'accepting') throw new Error(`Application operation admission is ${this.#admission}`);
    const active = this.#gate.active;
    if (active) throw new Error(`Operation ${active} is already active; ${operation} was not started`);
    if (operation !== 'safe-disconnect') {
      const action = allowedActionByOperation[operation];
      if (!this.snapshot().allowedActions[action]) {
        throw new Error(`Application policy does not allow ${operation} in the current state`);
      }
    }
    let outcome: ApplicationActionResult['outcome'];
    await this.#gate.run(operation, async () => {
      this.#operation = operation;
      try { outcome = await action(); }
      finally { this.#operation = undefined; }
    });
    return applicationActionResultSchema.parse({ outcome: outcome!, snapshot: this.snapshot() });
  }

  #timestamp(): string {
    return isoTimestampSchema.parse(this.timeAndIdentity.now().toISOString());
  }
}
