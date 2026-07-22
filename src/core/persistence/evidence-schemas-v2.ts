import { createHash } from 'node:crypto';
import { z } from 'zod';

const TARGET_PRODUCT = 'tinySA Ultra / Ultra+' as const;
const SOURCE_REPOSITORIES = ['PhysicistJohn/TinySA_Firmware', 'PhysicistJohn/Atom-Firmware'] as const;
const MAX_FIRMWARE_BYTES = 245_760;
const MINIMUM_UPDATE_BATTERY_MV = 3_900;

const targetCommonShape = {
  targetId: z.string().min(1).max(160).regex(/^[a-z0-9][a-z0-9._-]+$/),
  product: z.literal(TARGET_PRODUCT),
  version: z.string().trim().min(1).max(160).regex(/^[^\r\n]+$/),
  revision: z.string().regex(/^[a-f0-9]{7,40}$/),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().min(1).max(MAX_FIRMWARE_BYTES),
};

export const oemFirmwareTargetV2Schema = z.object({
  kind: z.literal('oem'),
  ...targetCommonShape,
  targetId: z.literal('oem-zs407-c979386'),
  version: z.literal('tinySA4_v1.4-224-gc979386'),
  revision: z.literal('c979386'),
  sourceCommit: z.literal('c97938697b6c7485e7cab50bca9af76996b7d671'),
  sha256: z.literal('3c9847ff4d7b80561df2f2f1030a112703a083409ffb2ee11361b2413b7c1e41'),
  sizeBytes: z.literal(185_704),
  publishedAt: z.literal('2026-05-06T11:33:12.000Z'),
  downloadUrl: z.literal('http://dfu.tinydevices.org/tinySA4/DFU/tinySA4_v1.4-224-gc979386.bin'),
  transportIntegrity: z.literal('pinned-sha256'),
}).strict();

export const localCustomFirmwareTargetV2Schema = z.object({
  kind: z.literal('local-custom'),
  ...targetCommonShape,
  sizeBytes: z.number().int().min(8 * 1024).max(MAX_FIRMWARE_BYTES),
  targetId: z.string().regex(/^custom-zs407-[a-f0-9]{64}$/),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  hardwareQualification: z.enum(['qualified', 'unqualified']),
  qualificationEvidenceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  buildProvenance: z.object({
    sourceRepository: z.enum(SOURCE_REPOSITORIES),
    chibiosCommit: z.string().regex(/^[a-f0-9]{40}$/),
    sourceDateEpoch: z.number().int().nonnegative(),
    toolchain: z.string().trim().min(1).max(200),
    reproducibleCleanBuilds: z.literal(true),
    simulationQualification: z.enum(['passed', 'not-run']),
  }).strict(),
  transportIntegrity: z.literal('local-manifest-sha256'),
}).strict().superRefine((target, context) => {
  if (target.targetId !== `custom-zs407-${target.sha256}`) {
    context.addIssue({ code: 'custom', message: 'Custom target ID does not match artifact SHA-256' });
  }
  if (target.version === 'tinySA4_v1.4-224-gc979386'
    || target.version === 'tinySA4_v1.4-217-gc5dd31f'
    || target.revision === 'c979386'
    || target.revision === 'c5dd31f') {
    context.addIssue({ code: 'custom', message: 'Custom target claims a reserved OEM identity' });
  }
  if (target.version.match(/-g([a-f0-9]{7,40})$/)?.[1] !== target.revision) {
    context.addIssue({ code: 'custom', message: 'Custom target version suffix differs from its reported revision' });
  }
  if (!target.sourceCommit.startsWith(target.revision)) {
    context.addIssue({ code: 'custom', message: 'Custom target source commit differs from its reported revision' });
  }
  if (target.hardwareQualification === 'qualified' && !target.qualificationEvidenceSha256) {
    context.addIssue({ code: 'custom', message: 'Qualified custom target lacks immutable qualification-evidence SHA-256' });
  }
  if (target.hardwareQualification === 'unqualified' && target.qualificationEvidenceSha256) {
    context.addIssue({ code: 'custom', message: 'Unqualified custom target claims qualification evidence' });
  }
});

export const firmwareTargetV2Schema = z.union([
  oemFirmwareTargetV2Schema,
  localCustomFirmwareTargetV2Schema,
]);
export type FirmwareTargetV2 = z.infer<typeof firmwareTargetV2Schema>;

const portCandidateV2Schema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  manufacturer: z.string().min(1).optional(),
  serialNumber: z.string().min(1).optional(),
  vendorId: z.literal('0483'),
  productId: z.literal('5740'),
  usbMatch: z.literal('exact-zs407-cdc'),
}).strict();

const deviceIdentityV2Schema = z.object({
  model: z.literal('tinySA Ultra+ ZS407'),
  hardwareVersion: z.string().min(1),
  firmwareVersion: z.string().min(1),
  firmwareReportedRevision: z.string().regex(/^[a-f0-9]{7,40}$/),
  firmwareSourceCommit: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  firmwareQualification: z.enum(['supported-oem', 'custom-unqualified']),
  firmwareWarning: z.string().min(1).optional(),
  port: portCandidateV2Schema,
  usbIdentityVerified: z.literal(true),
}).strict().superRefine((identity, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message });
  if (identity.firmwareQualification === 'supported-oem') {
    const expected = identity.firmwareVersion === 'tinySA4_v1.4-217-gc5dd31f'
      ? { revision: 'c5dd31f', sourceCommit: 'c5dd31fd4679c15ba92ff46a6e258c1e3516ff0c' }
      : identity.firmwareVersion === 'tinySA4_v1.4-224-gc979386'
        ? { revision: 'c979386', sourceCommit: 'c97938697b6c7485e7cab50bca9af76996b7d671' }
        : undefined;
    if (!expected || identity.firmwareReportedRevision !== expected.revision) {
      issue('Supported OEM identity is not an exact recognized version/revision pair');
    }
    if (identity.firmwareSourceCommit && identity.firmwareSourceCommit !== expected?.sourceCommit) {
      issue('Compatibility source commit differs from pinned OEM provenance');
    }
    if (identity.firmwareWarning) issue('Supported OEM identity cannot carry a custom warning');
  } else {
    if (!identity.firmwareWarning) issue('Custom identity requires an explicit warning');
    if (identity.firmwareSourceCommit) issue('Custom device identity cannot claim manifest source provenance');
  }
});

const telemetryV2Schema = z.object({
  batteryMillivolts: z.number().int().min(MINIMUM_UPDATE_BATTERY_MV),
  deviceId: z.number().int().nonnegative(),
  capturedAt: z.string().datetime(),
}).strict();

const usbContinuityV2Schema = z.object({
  cdcPath: z.string().min(1),
  cdcSerialNumber: z.string().min(1).optional(),
  vendorId: z.literal('0483'),
  productId: z.literal('5740'),
  deviceId: z.number().int().nonnegative(),
}).strict();

const preparationV2Schema = z.object({
  id: z.string().uuid(),
  preparedAt: z.string().datetime(),
  batteryMillivolts: z.number().int().min(MINIMUM_UPDATE_BATTERY_MV),
  deviceId: z.number().int().nonnegative(),
  screenSha256: z.string().regex(/^[a-f0-9]{64}$/),
  selfTestPassed: z.literal(true),
  selfTestProcedure: z.literal('tinySA4-zs407-cal-rf-v1'),
  configurationDisposition: z.enum(['new-device-unchanged', 'backup-complete-and-recalibration-accepted']),
  rfPortsDisconnected: z.literal(true),
  onlyUsbDeviceConnected: z.literal(true),
  usbContinuity: usbContinuityV2Schema,
}).strict().superRefine((preparation, context) => {
  if (preparation.deviceId !== preparation.usbContinuity.deviceId) {
    context.addIssue({ code: 'custom', message: 'Preparation and USB-continuity device IDs differ' });
  }
});

const artifactV2Schema = z.object({
  targetId: z.string().min(1),
  sizeBytes: z.number().int().min(1).max(MAX_FIRMWARE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  verifiedAt: z.string().datetime(),
}).strict();

const dfuIdentityV2Schema = z.object({
  path: z.string().min(1).regex(/^[^"\r\n]+$/),
  devnum: z.string().regex(/^\d+$/),
  serial: z.string().min(1).regex(/^[^"\r\n]+$/),
  alt: z.literal(0),
  name: z.string().startsWith('@Internal Flash').regex(/^[^"\r\n]+$/),
  fingerprint: z.string().min(1),
  targetLine: z.string().min(1).max(20_000),
}).strict().superRefine((identity, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message });
  const canonical = JSON.stringify({ path: identity.path, devnum: identity.devnum, serial: identity.serial, alt: identity.alt, name: identity.name });
  if (identity.fingerprint !== canonical) issue('DFU fingerprint is not canonical');
  try { inspectInternalFlashDescriptorV2(identity.name); }
  catch (value) { issue(value instanceof Error ? value.message : String(value)); }
  try {
    const target = parseDfuTargetLineV2(identity.targetLine);
    if (target.path !== identity.path || target.devnum !== identity.devnum || target.serial !== identity.serial
      || target.alt !== identity.alt || target.name !== identity.name) issue('DFU target line differs from persisted canonical identity');
  } catch (value) { issue(value instanceof Error ? value.message : String(value)); }
});

const currentFirmwareV2Schema = z.union([
  z.object({
    version: z.literal('tinySA4_v1.4-217-gc5dd31f'), revision: z.literal('c5dd31f'),
    sourceCommit: z.literal('c5dd31fd4679c15ba92ff46a6e258c1e3516ff0c').optional(), qualification: z.literal('supported-oem'),
  }).strict(),
  z.object({
    version: z.literal('tinySA4_v1.4-224-gc979386'), revision: z.literal('c979386'),
    sourceCommit: z.literal('c97938697b6c7485e7cab50bca9af76996b7d671').optional(), qualification: z.literal('supported-oem'),
  }).strict(),
  z.object({
    version: z.string().min(1), revision: z.string().regex(/^[a-f0-9]{7,40}$/), qualification: z.literal('custom-unqualified'),
  }).strict(),
]);

const phaseV2Schema = z.enum([
  'idle', 'available', 'downloading', 'verified', 'awaiting-dfu', 'ready-to-flash',
  'flashing', 'reconnecting', 'completed', 'up-to-date', 'failed',
]);
const dispositionV2Schema = z.enum(['not-started', 'started', 'completed', 'indeterminate']);
const relationV2Schema = z.enum(['unknown', 'same', 'different-supported', 'custom-current']);
const intentV2Schema = z.enum(['update-oem', 'restore-oem', 'install-custom']);

export const firmwareUpdateStateV2Schema = z.object({
  phase: phaseV2Schema,
  target: firmwareTargetV2Schema,
  targetRelation: relationV2Schema,
  writeIntent: intentV2Schema.optional(),
  updateAvailable: z.boolean(),
  current: currentFirmwareV2Schema.optional(),
  artifact: artifactV2Schema.optional(),
  dfuUtility: z.object({ available: z.boolean(), version: z.string().min(1).optional() }).strict().superRefine((utility, context) => {
    if (utility.available && !/^(?:dfu-util\s+)?0\.11$/.test(utility.version ?? '')) context.addIssue({ code: 'custom', message: 'Available DFU utility must be exact version 0.11' });
    if (!utility.available && utility.version !== undefined) context.addIssue({ code: 'custom', message: 'Unavailable DFU utility cannot claim a version' });
  }),
  dfuDevice: z.object({ detected: z.boolean(), count: z.number().int().nonnegative(), identity: dfuIdentityV2Schema.optional() }).strict().superRefine((device, context) => {
    if (device.detected && (device.count !== 1 || !device.identity)) context.addIssue({ code: 'custom', message: 'Detected DFU state requires exactly one canonical target' });
    if (!device.detected && device.identity) context.addIssue({ code: 'custom', message: 'Undetected DFU state cannot retain a canonical target' });
  }),
  preparation: preparationV2Schema.optional(),
  writeDisposition: dispositionV2Schema,
  writeStartedAt: z.string().datetime().optional(),
  writeCompletedAt: z.string().datetime().optional(),
  flashProgress: z.object({
    stage: z.enum(['preparing', 'erasing', 'writing', 'verifying-reboot', 'complete']),
    percent: z.number().int().min(0).max(100),
    stagePercent: z.number().int().min(0).max(100).optional(),
    updatedAt: z.string().datetime(),
  }).strict().optional(),
  completedAt: z.string().datetime().optional(),
  continuityWarning: z.string().min(1).optional(),
  warning: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
}).strict().superRefine((state, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message });
  const reportedIdentityMatchesTarget = Boolean(state.current
    && state.current.version === state.target.version
    && state.current.revision === state.target.revision
    && ((state.target.kind === 'oem' && state.current.qualification === 'supported-oem')
      || (state.target.kind === 'local-custom' && state.current.qualification === 'custom-unqualified')));
  const same = state.target.kind === 'oem'
    ? reportedIdentityMatchesTarget
    : reportedIdentityMatchesTarget
      && state.writeDisposition === 'completed'
      && Boolean(state.completedAt)
      && state.flashProgress?.stage === 'complete';
  const expectedRelation = !state.current ? 'unknown' : same ? 'same'
    : state.current.qualification === 'supported-oem' ? 'different-supported' : 'custom-current';
  const expectedIntent = expectedRelation === 'unknown' || expectedRelation === 'same' ? undefined
    : state.target.kind === 'local-custom' ? 'install-custom'
      : state.current?.qualification === 'custom-unqualified' ? 'restore-oem' : 'update-oem';
  if (state.targetRelation !== expectedRelation) issue('Target relation disagrees with current and target identities');
  if (state.updateAvailable !== (expectedRelation !== 'unknown' && expectedRelation !== 'same')) issue('Compatibility availability disagrees with target relation');
  const retainsCompletedIntent = state.writeDisposition === 'completed';
  if (!retainsCompletedIntent && state.writeIntent !== expectedIntent) issue('Write intent disagrees with current and target identities');
  if (retainsCompletedIntent) {
    if (!state.writeIntent) issue('Completed write disposition must retain its admitted write intent');
    if (state.target.kind === 'local-custom' && state.writeIntent !== 'install-custom') issue('Completed custom write must retain install-custom intent');
    if (state.target.kind === 'oem' && state.writeIntent !== 'update-oem' && state.writeIntent !== 'restore-oem') {
      issue('Completed OEM write must retain update-oem or restore-oem intent');
    }
    if (!same && expectedIntent && state.writeIntent !== expectedIntent) issue('Completed unverified write retains an intent inconsistent with its source identity');
  }
  if (state.artifact && (state.artifact.targetId !== state.target.targetId
    || state.artifact.sha256 !== state.target.sha256
    || state.artifact.sizeBytes !== state.target.sizeBytes)) issue('Artifact is not bound to the exact target');
  if (state.preparation && (!state.artifact || !state.writeIntent)) issue('Prepared transaction requires target artifact and write intent');
  if (state.writeDisposition === 'not-started' && (state.writeStartedAt || state.writeCompletedAt)) issue('Not-started state cannot have write timestamps');
  if (state.writeDisposition === 'started' && (!state.writeStartedAt || state.writeCompletedAt)) issue('Started state requires only writeStartedAt');
  if (state.writeDisposition === 'completed' && (!state.writeStartedAt || !state.writeCompletedAt)) issue('Completed disposition requires both write timestamps');
  if (state.writeDisposition === 'indeterminate' && state.phase !== 'failed') issue('Indeterminate disposition must remain failed');
  if (state.completedAt && (!['completed', 'failed'].includes(state.phase)
    || state.writeDisposition !== 'completed'
    || state.flashProgress?.stage !== 'complete')) {
    issue('Verification evidence requires completed state or a later failed state retaining complete write proof');
  }
  if (state.phase === 'idle' && (state.current || state.artifact || state.preparation || state.updateAvailable
    || state.dfuDevice.detected || state.writeDisposition !== 'not-started')) issue('Idle state carries transaction evidence');
  if ((state.phase === 'available' || state.phase === 'downloading')
    && (!state.current || expectedRelation === 'same' || expectedRelation === 'unknown' || !state.writeIntent
      || state.artifact || state.preparation || state.writeDisposition !== 'not-started'
      || (state.phase === 'downloading' && state.target.kind !== 'oem'))) issue(`${state.phase} lacks one unprepared different target`);
  if (state.phase === 'verified' && (!state.current || !state.artifact || state.preparation || !state.writeIntent
    || expectedRelation === 'same' || expectedRelation === 'unknown' || state.writeDisposition !== 'not-started')) issue('Verified state lacks one bound target artifact');
  if ((state.phase === 'awaiting-dfu' || state.phase === 'ready-to-flash')
    && (!state.preparation || !state.artifact || !state.writeIntent || expectedRelation === 'same'
      || expectedRelation === 'unknown' || state.writeDisposition !== 'not-started')) issue(`${state.phase} lacks a coherent prepared write`);
  if (state.phase === 'awaiting-dfu' && (state.dfuDevice.detected || state.dfuDevice.count !== 0)) issue('Awaiting-DFU state retains a selected DFU device');
  if (state.phase === 'ready-to-flash' && (!state.preparation || !state.dfuUtility.available
    || !state.dfuDevice.detected || state.dfuDevice.count !== 1 || !state.dfuDevice.identity)) issue('Ready state lacks admitted DFU/preflight evidence');
  if ((state.phase === 'flashing' || state.phase === 'reconnecting')
    && (!state.preparation || !state.artifact || !state.writeIntent || state.targetRelation === 'same')) issue(`${state.phase} lacks write context`);
  if (state.phase === 'completed' && (!same || state.targetRelation !== 'same' || !state.writeIntent
    || state.writeDisposition !== 'completed' || !state.completedAt || !state.preparation || !state.artifact
    || state.flashProgress?.stage !== 'complete' || state.error)) issue('Completed state lacks exact target verification evidence');
  if (state.phase === 'failed' && !state.error) issue('Failed state requires a diagnostic');
  if (state.phase === 'up-to-date' && (!same || state.writeIntent || state.preparation || state.writeDisposition !== 'not-started')) issue('Up-to-date state is not an exact unprepared target match');
  if (state.phase === 'flashing' && state.writeDisposition !== 'started') issue('Flashing phase requires durable write-start disposition');
  if (state.phase === 'reconnecting' && state.writeDisposition !== 'completed') issue('Reconnect phase requires durable write-complete disposition');
  if (state.artifact && state.preparation && !chronological(state.artifact.verifiedAt, state.preparation.preparedAt)) issue('Preparation precedes artifact verification');
  if (state.preparation && state.writeStartedAt && !chronological(state.preparation.preparedAt, state.writeStartedAt)) issue('Write start precedes preparation');
  if (state.writeStartedAt && state.writeCompletedAt && !chronological(state.writeStartedAt, state.writeCompletedAt)) issue('Write completion precedes write start');
  if (state.writeCompletedAt && state.completedAt && !chronological(state.writeCompletedAt, state.completedAt)) issue('Post-write verification precedes write completion');
  const progress = state.flashProgress;
  if (!progress) return;
  if (state.writeDisposition === 'not-started' || !state.writeStartedAt) issue('Flash progress requires durable write-start evidence');
  if (state.writeStartedAt && !chronological(state.writeStartedAt, progress.updatedAt)) issue('Flash progress precedes write start');
  if (!['flashing', 'reconnecting', 'completed', 'failed'].includes(state.phase)) issue('Flash progress is invalid before write start');
  if (state.phase === 'flashing' && !['preparing', 'erasing', 'writing'].includes(progress.stage)) issue('Flashing phase has an invalid progress stage');
  if (state.phase === 'reconnecting' && progress.stage !== 'verifying-reboot') issue('Reconnect phase requires verifying-reboot progress');
  if (progress.stage === 'preparing' && (progress.percent !== 0 || progress.stagePercent !== undefined)) issue('Preparing progress must be zero');
  if (progress.stage === 'erasing' && (progress.percent > 40 || progress.stagePercent === undefined)) issue('Erase progress is invalid');
  if (progress.stage === 'writing' && (progress.percent < 40 || progress.percent > 95 || progress.stagePercent === undefined)) issue('Write progress is invalid');
  if (progress.stage === 'verifying-reboot' && (progress.percent !== 98 || progress.stagePercent !== 100)) issue('Verification progress is invalid');
  if (progress.stage === 'complete' && (progress.percent !== 100 || progress.stagePercent !== 100)) issue('Completed progress is invalid');
});
export type FirmwareUpdateStateV2 = z.infer<typeof firmwareUpdateStateV2Schema>;

export const firmwareUpdateJournalV2Schema = z.object({
  schemaVersion: z.literal(2),
  targetId: z.string().min(1),
  targetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  writtenAt: z.string().datetime(),
  state: firmwareUpdateStateV2Schema,
}).strict().superRefine((journal, context) => {
  if (journal.targetId !== journal.state.target.targetId) context.addIssue({ code: 'custom', message: 'Journal target ID differs from embedded target' });
  const expectedTargetSha256 = validFirmwareTargetV2Sha256(journal.state.target);
  if (expectedTargetSha256 && journal.targetSha256 !== expectedTargetSha256) context.addIssue({ code: 'custom', message: 'Journal target hash differs from embedded target' });
});
export type FirmwareUpdateJournalV2 = z.infer<typeof firmwareUpdateJournalV2Schema>;

export const completedLedgerV2Schema = firmwareUpdateJournalV2Schema.superRefine((journal, context) => {
  const state = journal.state;
  if (state.phase !== 'completed' || state.writeDisposition !== 'completed' || !state.preparation || !state.artifact) {
    context.addIssue({ code: 'custom', message: 'Completed ledger requires a verified completed transaction' });
  }
  if (!state.dfuUtility.available || state.dfuUtility.version !== '0.11'
    || !state.dfuDevice.detected || state.dfuDevice.count !== 1 || !state.dfuDevice.identity) {
    context.addIssue({ code: 'custom', message: 'Completed ledger must retain exact DFU admission evidence' });
  }
  if (state.artifact && state.preparation && state.writeStartedAt && state.writeCompletedAt && state.completedAt
    && !isChronological([state.artifact.verifiedAt, state.preparation.preparedAt, state.writeStartedAt, state.writeCompletedAt, state.completedAt, journal.writtenAt])) {
    context.addIssue({ code: 'custom', message: 'Completed ledger timestamps are not chronological' });
  }
  if (state.flashProgress && state.completedAt && !sameInstant(state.flashProgress.updatedAt, state.completedAt)) {
    context.addIssue({ code: 'custom', message: 'Completed ledger final progress timestamp differs from post-reboot verification time' });
  }
});
export type CompletedLedgerV2 = z.infer<typeof completedLedgerV2Schema>;

export const preflightRecordV2Schema = z.object({
  schemaVersion: z.literal(2),
  target: firmwareTargetV2Schema,
  targetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  preparation: preparationV2Schema,
  identity: deviceIdentityV2Schema,
  firmwareVersionResponse: z.string().min(1),
  infoLines: z.array(z.string().trim().min(1)).min(1),
  commands: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(1),
  telemetry: telemetryV2Schema,
  artifact: artifactV2Schema,
}).strict().superRefine((record, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message });
  const expectedTargetSha256 = validFirmwareTargetV2Sha256(record.target);
  if (expectedTargetSha256 && record.targetSha256 !== expectedTargetSha256) issue('Preflight target hash differs from embedded target');
  if (record.artifact.targetId !== record.target.targetId
    || record.artifact.sha256 !== record.target.sha256
    || record.artifact.sizeBytes !== record.target.sizeBytes) issue('Preflight artifact differs from target');
  if (record.preparation.deviceId !== record.telemetry.deviceId
    || record.preparation.batteryMillivolts !== record.telemetry.batteryMillivolts) issue('Preflight preparation differs from telemetry');
  if (record.preparation.usbContinuity.cdcPath !== record.identity.port.path
    || record.preparation.usbContinuity.cdcSerialNumber !== record.identity.port.serialNumber) issue('Preflight USB identity differs from diagnostics');
  const versionLine = record.firmwareVersionResponse.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (versionLine !== record.identity.firmwareVersion) issue('Preflight version response differs from diagnostics');
  const targetQualification = record.target.kind === 'oem' ? 'supported-oem' : 'custom-unqualified';
  if (record.target.kind === 'oem'
    && record.identity.firmwareVersion === record.target.version
    && record.identity.firmwareReportedRevision === record.target.revision
    && record.identity.firmwareQualification === targetQualification) {
    issue('Preflight source identity already matches the exact selected OEM target');
  }
  if (!record.infoLines.some((line) => /tinySA/i.test(line))) issue('Preflight info response does not identify tinySA firmware');
  const requiredCommands = ['version', 'info', 'help', 'mode', 'output', 'vbat', 'deviceid', 'capture'];
  const missingCommands = requiredCommands.filter((command) => !record.commands.includes(command));
  if (missingCommands.length) issue(`Preflight command catalog is missing: ${missingCommands.join(', ')}`);
  if (!isChronological([record.artifact.verifiedAt, record.telemetry.capturedAt, record.preparation.preparedAt])) issue('Preflight timestamps are not chronological');
});
export type PreflightRecordV2 = z.infer<typeof preflightRecordV2Schema>;

const auditEnvelopeV2Shape = {
  schemaVersion: z.literal(2),
  target: firmwareTargetV2Schema,
  targetSha256: z.string().regex(/^[a-f0-9]{64}$/),
};
export const writeStartedAuditV2Schema = z.object({
  ...auditEnvelopeV2Shape,
  stage: z.literal('write-started'),
  value: z.object({ preparationId: z.string().uuid(), writeStartedAt: z.string().datetime(), dfuIdentity: dfuIdentityV2Schema }).strict(),
}).strict();
export const writeCompleteAuditV2Schema = z.object({
  ...auditEnvelopeV2Shape,
  stage: z.literal('write-complete'),
  value: z.object({
    preparationId: z.string().uuid(), writeCompletedAt: z.string().datetime(), dfuIdentity: dfuIdentityV2Schema,
    output: z.string().max(20_000), outputTruncated: z.boolean(), exceededExpectedDuration: z.boolean(),
  }).strict(),
}).strict();
export const verifiedCompleteAuditV2Schema = z.object({
  ...auditEnvelopeV2Shape,
  stage: z.literal('verified-complete'),
  value: z.object({
    preparationId: z.string().uuid(), writeCompletedAt: z.string().datetime(), completedAt: z.string().datetime(),
    identity: deviceIdentityV2Schema, deviceId: z.number().int().nonnegative(),
  }).strict(),
}).strict().superRefine((audit, context) => {
  if (!chronological(audit.value.writeCompletedAt, audit.value.completedAt)) context.addIssue({ code: 'custom', message: 'Verification precedes write completion' });
  const expectedQualification = audit.target.kind === 'oem' ? 'supported-oem' : 'custom-unqualified';
  if (audit.value.identity.firmwareVersion !== audit.target.version
    || audit.value.identity.firmwareReportedRevision !== audit.target.revision
    || audit.value.identity.firmwareQualification !== expectedQualification) {
    context.addIssue({ code: 'custom', message: 'Verified device identity differs from exact target version/revision/kind' });
  }
});
export const transactionAuditV2Schema = z.union([
  writeStartedAuditV2Schema,
  writeCompleteAuditV2Schema,
  verifiedCompleteAuditV2Schema,
]).superRefine((audit, context) => {
  const expectedTargetSha256 = validFirmwareTargetV2Sha256(audit.target);
  if (expectedTargetSha256 && audit.targetSha256 !== expectedTargetSha256) context.addIssue({ code: 'custom', message: 'Audit target hash differs from embedded target' });
});
export type TransactionAuditV2 = z.infer<typeof transactionAuditV2Schema>;

export function firmwareTargetV2Sha256(targetValue: unknown): string {
  const target = firmwareTargetV2Schema.parse(targetValue);
  return createHash('sha256').update(JSON.stringify(target)).digest('hex');
}

function validFirmwareTargetV2Sha256(targetValue: unknown): string | undefined {
  const target = firmwareTargetV2Schema.safeParse(targetValue);
  return target.success ? createHash('sha256').update(JSON.stringify(target.data)).digest('hex') : undefined;
}

function chronological(left: string, right: string): boolean { return Date.parse(left) <= Date.parse(right); }
function sameInstant(left: string, right: string): boolean { return Date.parse(left) === Date.parse(right); }
function isChronological(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || chronological(values[index - 1]!, value));
}

interface DfuTargetLineV2 { path: string; devnum: string; serial: string; alt: 0; name: string }
function parseDfuTargetLineV2(line: string): DfuTargetLineV2 {
  if (/[\r\n]/.test(line)) throw new Error('DFU target line must contain exactly one line');
  if ([...line.matchAll(/Found DFU:\s*\[0483:df11\]/gi)].length !== 1) throw new Error('DFU target line must identify exactly one 0483:df11 device');
  const path = singleField(line, /\bpath="([^"]+)"/gi, 'path');
  const devnum = singleField(line, /\bdevnum=(\d+)\b/gi, 'devnum');
  const serial = singleField(line, /\bserial="([^"]+)"/gi, 'serial');
  const alt = singleField(line, /\balt=(\d+)\b/gi, 'alt');
  const name = singleField(line, /\bname="([^"]+)"/gi, 'name');
  if (alt !== '0') throw new Error('DFU target line must select alt 0');
  return { path, devnum, serial, alt: 0, name };
}

function singleField(line: string, pattern: RegExp, label: string): string {
  const matches = [...line.matchAll(pattern)];
  if (matches.length !== 1 || !matches[0]![1]) throw new Error(`DFU target line must contain exactly one nonempty ${label}`);
  return matches[0]![1]!;
}

function inspectInternalFlashDescriptorV2(name: string): void {
  const match = name.match(/^@Internal Flash\s+\/0x([0-9a-f]+)\/(.+)$/i);
  if (!match || Number.parseInt(match[1]!, 16) !== 0x08000000) throw new Error('DFU internal flash must begin at 0x08000000');
  let capacity = 0;
  for (const raw of match[2]!.split(',')) {
    const segment = raw.trim();
    const geometry = segment.match(/^(\d+)\s*\*\s*(\d+)\s*([KMG]?)([a-g])$/i);
    if (!geometry) throw new Error(`Malformed DFU internal-flash geometry: ${segment}`);
    if (!['f', 'g'].includes(geometry[4]!.toLowerCase())) throw new Error(`DFU flash geometry is not erasable and writable: ${segment}`);
    const multiplier = geometry[3]!.toUpperCase() === 'K' ? 1024 : geometry[3]!.toUpperCase() === 'M' ? 1024 ** 2 : geometry[3]!.toUpperCase() === 'G' ? 1024 ** 3 : 1;
    const bytes = Number(geometry[1]) * Number(geometry[2]) * multiplier;
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`Invalid DFU flash geometry size: ${segment}`);
    capacity += bytes;
  }
  if (!Number.isSafeInteger(capacity) || capacity < MAX_FIRMWARE_BYTES) throw new Error(`DFU internal-flash capacity ${capacity} is smaller than an admitted image`);
}
