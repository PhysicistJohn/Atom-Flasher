import { z } from 'zod';

/**
 * Immutable release snapshot embedded in evidence schema v1.
 *
 * Do not replace these values when the active release changes. A future target
 * gets a new durable schema version and an additional registry entry below.
 */
export const EVIDENCE_V1_FIRMWARE_RELEASE = Object.freeze({
  product: 'tinySA Ultra / Ultra+',
  version: 'tinySA4_v1.4-224-gc979386',
  revision: 'c979386',
  sourceCommit: 'c97938697b6c7485e7cab50bca9af76996b7d671',
  publishedAt: '2026-05-06T11:33:12.000Z',
  downloadUrl: 'http://dfu.tinydevices.org/tinySA4/DFU/tinySA4_v1.4-224-gc979386.bin',
  sha256: '3c9847ff4d7b80561df2f2f1030a112703a083409ffb2ee11361b2413b7c1e41',
  sizeBytes: 185_704,
  transportIntegrity: 'pinned-sha256',
} as const);

const SHIPPED_FIRMWARE = Object.freeze({
  version: 'tinySA4_v1.4-217-gc5dd31f',
  revision: 'c5dd31f',
  sourceCommit: 'c5dd31fd4679c15ba92ff46a6e258c1e3516ff0c',
} as const);

const releaseV1Schema = z.object({
  product: z.literal(EVIDENCE_V1_FIRMWARE_RELEASE.product),
  version: z.literal(EVIDENCE_V1_FIRMWARE_RELEASE.version),
  revision: z.literal(EVIDENCE_V1_FIRMWARE_RELEASE.revision),
  sourceCommit: z.literal(EVIDENCE_V1_FIRMWARE_RELEASE.sourceCommit),
  publishedAt: z.literal(EVIDENCE_V1_FIRMWARE_RELEASE.publishedAt),
  downloadUrl: z.literal(EVIDENCE_V1_FIRMWARE_RELEASE.downloadUrl),
  sha256: z.literal(EVIDENCE_V1_FIRMWARE_RELEASE.sha256),
  sizeBytes: z.literal(EVIDENCE_V1_FIRMWARE_RELEASE.sizeBytes),
  transportIntegrity: z.literal(EVIDENCE_V1_FIRMWARE_RELEASE.transportIntegrity),
}).strict();

const firmwarePhaseV1Schema = z.enum([
  'idle', 'available', 'downloading', 'verified', 'awaiting-dfu', 'ready-to-flash',
  'flashing', 'reconnecting', 'completed', 'up-to-date', 'custom-firmware', 'failed',
]);
const writeDispositionV1Schema = z.enum(['not-started', 'started', 'completed', 'indeterminate']);
const progressStageV1Schema = z.enum(['preparing', 'erasing', 'writing', 'verifying-reboot', 'complete']);

export const usbContinuityV1Schema = z.object({
  cdcPath: z.string().min(1),
  cdcSerialNumber: z.string().min(1).optional(),
  vendorId: z.literal('0483'),
  productId: z.literal('5740'),
  deviceId: z.number().int().nonnegative(),
}).strict();

const dfuIdentityV1Shape = z.object({
  path: z.string().min(1),
  devnum: z.string().regex(/^(?:0|[1-9]\d*)$/),
  serial: z.string().min(1),
  alt: z.literal(0),
  name: z.string().startsWith('@Internal Flash'),
  fingerprint: z.string().min(1),
  targetLine: z.string().min(1).max(20_000),
}).strict();

export const dfuIdentityV1Schema = dfuIdentityV1Shape.superRefine((identity, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message });
  const canonicalFingerprint = JSON.stringify({
    path: identity.path,
    devnum: identity.devnum,
    serial: identity.serial,
    alt: identity.alt,
    name: identity.name,
  });
  if (identity.fingerprint !== canonicalFingerprint) issue('DFU fingerprint is not the canonical identity serialization');

  try { inspectHistoricalInternalFlashDescriptor(identity.name); }
  catch (value) { issue(value instanceof Error ? value.message : String(value)); }

  try {
    const target = parseHistoricalDfuTargetLine(identity.targetLine);
    if (target.path !== identity.path
      || target.devnum !== identity.devnum
      || target.serial !== identity.serial
      || target.alt !== identity.alt
      || target.name !== identity.name) {
      issue('DFU target line does not reproduce the persisted identity fields');
    }
  } catch (value) {
    issue(value instanceof Error ? value.message : String(value));
  }
});

export const preparationV1Schema = z.object({
  id: z.string().uuid(),
  preparedAt: z.string().datetime(),
  batteryMillivolts: z.number().int().min(4_000),
  deviceId: z.number().int().nonnegative(),
  screenSha256: z.string().regex(/^[a-f0-9]{64}$/),
  selfTestPassed: z.literal(true),
  selfTestProcedure: z.literal('tinySA4-zs407-cal-rf-v1'),
  configurationDisposition: z.enum(['new-device-unchanged', 'backup-complete-and-recalibration-accepted']),
  rfPortsDisconnected: z.literal(true),
  onlyUsbDeviceConnected: z.literal(true),
  usbContinuity: usbContinuityV1Schema,
}).strict().superRefine((preparation, context) => {
  if (preparation.deviceId !== preparation.usbContinuity.deviceId) {
    context.addIssue({ code: 'custom', message: 'Preparation and USB-continuity device IDs differ' });
  }
});

const supportedFirmwareV1Schema = z.union([
  z.object({
    version: z.literal(SHIPPED_FIRMWARE.version),
    revision: z.literal(SHIPPED_FIRMWARE.revision),
    sourceCommit: z.literal(SHIPPED_FIRMWARE.sourceCommit),
    qualification: z.literal('supported-oem'),
  }).strict(),
  z.object({
    version: z.literal(EVIDENCE_V1_FIRMWARE_RELEASE.version),
    revision: z.literal(EVIDENCE_V1_FIRMWARE_RELEASE.revision),
    sourceCommit: z.literal(EVIDENCE_V1_FIRMWARE_RELEASE.sourceCommit),
    qualification: z.literal('supported-oem'),
  }).strict(),
]);

export const firmwareUpdateStateV1Schema = z.object({
  phase: firmwarePhaseV1Schema,
  target: releaseV1Schema,
  updateAvailable: z.boolean(),
  current: z.union([
    supportedFirmwareV1Schema,
    z.object({
      version: z.string().min(1),
      revision: z.string().regex(/^[a-f0-9]{7,40}$/),
      qualification: z.literal('custom-unqualified'),
    }).strict(),
  ]).optional(),
  artifact: z.object({
    sizeBytes: z.literal(EVIDENCE_V1_FIRMWARE_RELEASE.sizeBytes),
    sha256: z.literal(EVIDENCE_V1_FIRMWARE_RELEASE.sha256),
    verifiedAt: z.string().datetime(),
  }).strict().optional(),
  dfuUtility: z.object({ available: z.boolean(), version: z.string().min(1).optional() }).strict(),
  dfuDevice: z.object({ detected: z.boolean(), count: z.number().int().nonnegative(), identity: dfuIdentityV1Schema.optional() }).strict(),
  preparation: preparationV1Schema.optional(),
  writeDisposition: writeDispositionV1Schema,
  writeStartedAt: z.string().datetime().optional(),
  writeCompletedAt: z.string().datetime().optional(),
  flashProgress: z.object({
    stage: progressStageV1Schema,
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
  if (state.writeDisposition === 'not-started' && (state.writeStartedAt || state.writeCompletedAt)) issue('A not-started write cannot have write timestamps');
  if (state.writeDisposition === 'started' && (!state.writeStartedAt || state.writeCompletedAt)) issue('A started write requires only writeStartedAt');
  if (state.writeDisposition === 'completed' && (!state.writeStartedAt || !state.writeCompletedAt)) issue('A completed write requires both write timestamps');
  if (state.writeDisposition === 'indeterminate' && state.phase !== 'failed') issue('An indeterminate write disposition must remain failed');
  if (['flashing', 'reconnecting', 'completed'].includes(state.phase) && state.writeDisposition === 'not-started') issue(`${state.phase} requires durable write evidence`);
  if (state.phase === 'completed' && (state.writeDisposition !== 'completed' || !state.completedAt)) issue('Completed state requires a completed write and verification time');
  if (state.phase === 'custom-firmware' && (!state.current || state.current.qualification !== 'custom-unqualified' || state.updateAvailable || !state.warning)) issue('Custom firmware state must be warned and unavailable');
  if (state.phase === 'ready-to-flash' && (!state.dfuDevice.detected || state.dfuDevice.count !== 1 || !state.dfuDevice.identity)) issue('Ready-to-flash requires one identified DFU target');
  if (state.dfuDevice.detected && (!state.dfuDevice.identity || state.dfuDevice.count !== 1)) issue('Detected DFU state requires exactly one persisted identity');
  if (state.writeStartedAt && state.writeCompletedAt && Date.parse(state.writeCompletedAt) < Date.parse(state.writeStartedAt)) issue('Write completion cannot precede start');
  if (state.writeCompletedAt && state.completedAt && Date.parse(state.completedAt) < Date.parse(state.writeCompletedAt)) issue('Verification cannot precede write completion');
  const progress = state.flashProgress;
  if (!progress) return;
  if (state.writeDisposition === 'not-started' || !state.writeStartedAt) issue('Progress requires durable write-start evidence');
  if (state.writeStartedAt && Date.parse(progress.updatedAt) < Date.parse(state.writeStartedAt)) issue('Progress cannot precede write start');
  if (!['flashing', 'reconnecting', 'completed', 'failed'].includes(state.phase)) issue('Progress is legal only after write start');
  if (state.phase === 'flashing' && !['preparing', 'erasing', 'writing'].includes(progress.stage)) issue('Invalid flashing progress stage');
  if (state.phase === 'reconnecting' && progress.stage !== 'verifying-reboot') issue('Reconnect requires verifying-reboot stage');
  if (state.phase === 'completed' && progress.stage !== 'complete') issue('Completed state requires complete progress');
  if (progress.stage === 'preparing' && (progress.percent !== 0 || progress.stagePercent !== undefined)) issue('Preparing progress must be zero');
  if (progress.stage === 'erasing' && (progress.percent > 40 || progress.stagePercent === undefined)) issue('Invalid erase progress');
  if (progress.stage === 'writing' && (progress.percent < 40 || progress.percent > 95 || progress.stagePercent === undefined)) issue('Invalid write progress');
  if (progress.stage === 'verifying-reboot' && (progress.percent !== 98 || progress.stagePercent !== 100)) issue('Invalid verification progress');
  if (progress.stage === 'complete' && (progress.percent !== 100 || progress.stagePercent !== 100)) issue('Invalid completed progress');
});

export const firmwareUpdateJournalV1Schema = z.object({
  schemaVersion: z.literal(1),
  targetVersion: z.literal(EVIDENCE_V1_FIRMWARE_RELEASE.version),
  writtenAt: z.string().datetime(),
  state: firmwareUpdateStateV1Schema,
}).strict();
export type FirmwareUpdateJournalV1 = z.infer<typeof firmwareUpdateJournalV1Schema>;

export const completedLedgerV1Schema = firmwareUpdateJournalV1Schema.superRefine((journal, context) => {
  const { state } = journal;
  const issue = (message: string) => context.addIssue({ code: 'custom', message });
  if (state.phase !== 'completed') issue('Completed ledger phase must be completed');
  if (state.writeDisposition !== 'completed') issue('Completed ledger write disposition must be completed');
  if (state.updateAvailable) issue('Completed ledger must record that no update remains available');
  if (!state.preparation) issue('Completed ledger must retain preparation identity');
  if (!state.artifact) issue('Completed ledger must retain the verified pinned artifact');
  if (!state.current
    || state.current.qualification !== 'supported-oem'
    || state.current.version !== EVIDENCE_V1_FIRMWARE_RELEASE.version
    || state.current.revision !== EVIDENCE_V1_FIRMWARE_RELEASE.revision
    || state.current.sourceCommit !== EVIDENCE_V1_FIRMWARE_RELEASE.sourceCommit) {
    issue('Completed ledger must retain the exact target OEM firmware identity');
  }
  if (!state.dfuUtility.available || state.dfuUtility.version !== '0.11') {
    issue('Completed ledger must retain admitted dfu-util 0.11 evidence');
  }
  if (!state.dfuDevice.detected || state.dfuDevice.count !== 1 || !state.dfuDevice.identity) {
    issue('Completed ledger must retain one exact admitted DFU identity');
  }
  if (!state.flashProgress
    || state.flashProgress.stage !== 'complete'
    || state.flashProgress.percent !== 100
    || state.flashProgress.stagePercent !== 100) {
    issue('Completed ledger must retain complete post-write progress evidence');
  }
  if (state.error) issue('Completed ledger cannot retain a transaction error');

  if (!state.preparation || !state.artifact || !state.writeStartedAt || !state.writeCompletedAt || !state.completedAt) return;
  const ordered = [
    state.artifact.verifiedAt,
    state.preparation.preparedAt,
    state.writeStartedAt,
    state.writeCompletedAt,
    state.completedAt,
    journal.writtenAt,
  ];
  if (!isChronological(ordered)) issue('Completed ledger timestamps are not in artifact/preparation/write/verification/journal order');
  if (state.flashProgress && !sameInstant(state.flashProgress.updatedAt, state.completedAt)) {
    issue('Completed ledger final progress timestamp must equal completion verification time');
  }
});
export type CompletedLedgerV1 = z.infer<typeof completedLedgerV1Schema>;

const portCandidateV1Schema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  manufacturer: z.string().min(1).optional(),
  serialNumber: z.string().min(1).optional(),
  vendorId: z.literal('0483'),
  productId: z.literal('5740'),
  usbMatch: z.literal('exact-zs407-cdc'),
}).strict();

const supportedDeviceIdentityV1Schema = z.object({
  model: z.literal('tinySA Ultra+ ZS407'),
  hardwareVersion: z.string().min(1),
  firmwareVersion: z.union([z.literal(SHIPPED_FIRMWARE.version), z.literal(EVIDENCE_V1_FIRMWARE_RELEASE.version)]),
  firmwareReportedRevision: z.union([z.literal(SHIPPED_FIRMWARE.revision), z.literal(EVIDENCE_V1_FIRMWARE_RELEASE.revision)]),
  firmwareSourceCommit: z.union([z.literal(SHIPPED_FIRMWARE.sourceCommit), z.literal(EVIDENCE_V1_FIRMWARE_RELEASE.sourceCommit)]),
  firmwareQualification: z.literal('supported-oem'),
  firmwareWarning: z.string().min(1).optional(),
  port: portCandidateV1Schema,
  usbIdentityVerified: z.literal(true),
}).strict().superRefine((identity, context) => {
  const expected = identity.firmwareVersion === SHIPPED_FIRMWARE.version ? SHIPPED_FIRMWARE : EVIDENCE_V1_FIRMWARE_RELEASE;
  if (identity.firmwareReportedRevision !== expected.revision || identity.firmwareSourceCommit !== expected.sourceCommit) {
    context.addIssue({ code: 'custom', message: 'Device identity firmware provenance is internally inconsistent' });
  }
});

const telemetryV1Schema = z.object({
  batteryMillivolts: z.number().int().positive(),
  deviceId: z.number().int().nonnegative(),
  capturedAt: z.string().datetime(),
}).strict();

export const preflightRecordV1Schema = z.object({
  schemaVersion: z.literal(1),
  target: releaseV1Schema,
  preparation: preparationV1Schema,
  identity: supportedDeviceIdentityV1Schema,
  firmwareVersionResponse: z.string().min(1),
  infoLines: z.array(z.string().trim().min(1)).min(1),
  commands: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(1),
  telemetry: telemetryV1Schema,
  artifact: z.object({
    sizeBytes: z.literal(EVIDENCE_V1_FIRMWARE_RELEASE.sizeBytes),
    sha256: z.literal(EVIDENCE_V1_FIRMWARE_RELEASE.sha256),
    verifiedAt: z.string().datetime(),
  }).strict(),
}).strict().superRefine((record, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message });
  const { artifact, identity, preparation, telemetry } = record;
  if (preparation.deviceId !== telemetry.deviceId) issue('Preflight preparation and telemetry device IDs differ');
  if (preparation.batteryMillivolts !== telemetry.batteryMillivolts) issue('Preflight preparation and telemetry battery readings differ');
  if (preparation.usbContinuity.cdcPath !== identity.port.path
    || preparation.usbContinuity.cdcSerialNumber !== identity.port.serialNumber
    || preparation.usbContinuity.vendorId !== identity.port.vendorId
    || preparation.usbContinuity.productId !== identity.port.productId) {
    issue('Preflight prepared USB identity differs from diagnosed USB identity');
  }
  const versionLine = record.firmwareVersionResponse.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (versionLine !== identity.firmwareVersion) issue('Preflight firmware version response differs from diagnosed firmware identity');
  if (!record.infoLines.some((line) => /tinySA/i.test(line))) issue('Preflight info response does not identify tinySA firmware');
  const requiredCommands = ['version', 'info', 'help', 'mode', 'output', 'vbat', 'deviceid', 'capture'];
  const missingCommands = requiredCommands.filter((command) => !record.commands.includes(command));
  if (missingCommands.length) issue(`Preflight command catalog is missing: ${missingCommands.join(', ')}`);
  if (!isChronological([artifact.verifiedAt, telemetry.capturedAt, preparation.preparedAt])) {
    issue('Preflight timestamps are not in artifact/telemetry/preparation order');
  }
});

const auditEnvelopeV1Schema = z.object({
  schemaVersion: z.literal(1),
  target: releaseV1Schema,
}).strict();

export const writeStartedAuditV1Schema = auditEnvelopeV1Schema.extend({
  stage: z.literal('write-started'),
  value: z.object({
    preparationId: z.string().uuid(),
    writeStartedAt: z.string().datetime(),
    dfuIdentity: dfuIdentityV1Schema,
  }).strict(),
}).strict();

export const writeCompleteAuditV1Schema = auditEnvelopeV1Schema.extend({
  stage: z.literal('write-complete'),
  value: z.object({
    preparationId: z.string().uuid(),
    writeCompletedAt: z.string().datetime(),
    dfuIdentity: dfuIdentityV1Schema,
    output: z.string().max(20_000),
    outputTruncated: z.boolean(),
    exceededExpectedDuration: z.boolean(),
  }).strict(),
}).strict();

export const verifiedCompleteAuditV1Schema = auditEnvelopeV1Schema.extend({
  stage: z.literal('verified-complete'),
  value: z.object({
    preparationId: z.string().uuid(),
    writeCompletedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    identity: supportedDeviceIdentityV1Schema,
    deviceId: z.number().int().nonnegative(),
  }).strict(),
}).strict().superRefine((audit, context) => {
  if (Date.parse(audit.value.completedAt) < Date.parse(audit.value.writeCompletedAt)) {
    context.addIssue({ code: 'custom', message: 'Verified completion cannot precede write completion' });
  }
  if (audit.value.identity.firmwareVersion !== EVIDENCE_V1_FIRMWARE_RELEASE.version
    || audit.value.identity.firmwareReportedRevision !== EVIDENCE_V1_FIRMWARE_RELEASE.revision
    || audit.value.identity.firmwareSourceCommit !== EVIDENCE_V1_FIRMWARE_RELEASE.sourceCommit) {
    context.addIssue({ code: 'custom', message: 'Verified completion must retain the exact target OEM firmware identity' });
  }
});

export const transactionAuditV1Schema = z.discriminatedUnion('stage', [
  writeStartedAuditV1Schema,
  writeCompleteAuditV1Schema,
  verifiedCompleteAuditV1Schema,
]);
export type TransactionAuditV1 = z.infer<typeof transactionAuditV1Schema>;

const lockBaseV1Shape = {
  schemaVersion: z.literal(1),
  ownerToken: z.string().uuid(),
  acquiredAt: z.string().datetime(),
};
export const writeLockV1Schema = z.object({
  ...lockBaseV1Shape,
  purpose: z.literal('firmware-write'),
  preparationId: z.string().uuid(),
  dfuIdentity: dfuIdentityV1Schema,
}).strict();
export const journalLockV1Schema = z.object({
  ...lockBaseV1Shape,
  purpose: z.literal('journal-mutation'),
}).strict();
export const durableLockV1Schema = z.discriminatedUnion('purpose', [writeLockV1Schema, journalLockV1Schema]);

export const migrationEvidenceReferenceV1Schema = z.object({
  path: z.string().min(1),
  relativePath: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const migrationMarkerV1Schema = z.object({
  schemaVersion: z.literal(1),
  checkedAt: z.string().datetime(),
  status: z.enum(['none', 'imported', 'already-current']),
  sources: z.array(z.string()),
  importedEvidence: z.array(z.string()),
  consumedEvidence: z.array(migrationEvidenceReferenceV1Schema),
}).strict();
export type MigrationMarkerV1 = z.infer<typeof migrationMarkerV1Schema>;

export const migrationConflictV1Schema = z.object({
  schemaVersion: z.literal(1),
  detectedAt: z.string().datetime(),
  reason: z.string().min(1),
  evidence: z.array(migrationEvidenceReferenceV1Schema),
}).strict();

interface HistoricalDfuTargetLine {
  path: string;
  devnum: string;
  serial: string;
  alt: 0;
  name: string;
}

function parseHistoricalDfuTargetLine(line: string): HistoricalDfuTargetLine {
  if (/[\r\n]/.test(line)) throw new Error('DFU target line must contain exactly one line');
  const found = [...line.matchAll(/Found DFU:\s*\[0483:df11\]/gi)];
  if (found.length !== 1) throw new Error('DFU target line must identify exactly one 0483:df11 device');
  const path = singleCapturedField(line, /\bpath="([^"]+)"/gi, 'path');
  const devnum = singleCapturedField(line, /\bdevnum=(\d+)\b/gi, 'devnum');
  const serial = singleCapturedField(line, /\bserial="([^"]+)"/gi, 'serial');
  const altText = singleCapturedField(line, /\balt=(\d+)\b/gi, 'alt');
  const name = singleCapturedField(line, /\bname="([^"]+)"/gi, 'name');
  if (altText !== '0') throw new Error('DFU target line must select alt 0');
  return { path, devnum, serial, alt: 0, name };
}

function singleCapturedField(line: string, pattern: RegExp, label: string): string {
  const matches = [...line.matchAll(pattern)];
  if (matches.length !== 1 || !matches[0]![1]) throw new Error(`DFU target line must contain exactly one nonempty ${label}`);
  return matches[0]![1]!;
}

function inspectHistoricalInternalFlashDescriptor(name: string): void {
  const match = name.match(/^@Internal Flash\s+\/0x([0-9a-f]+)\/(.+)$/i);
  if (!match) throw new Error('DFU identity has a malformed internal-flash descriptor');
  const startAddress = Number.parseInt(match[1]!, 16);
  if (startAddress !== 0x08000000) throw new Error('DFU internal flash does not start at 0x08000000');
  let capacityBytes = 0;
  for (const rawSegment of match[2]!.split(',')) {
    const segment = rawSegment.trim();
    const geometry = segment.match(/^(\d+)\s*\*\s*(\d+)\s*([KMG]?)([a-g])$/i);
    if (!geometry) throw new Error(`DFU internal-flash geometry segment is malformed: ${segment}`);
    const attributes = geometry[4]!.toLowerCase();
    if (attributes !== 'f' && attributes !== 'g') {
      throw new Error(`DFU internal-flash geometry is not both erasable and writable: ${segment}`);
    }
    const multiplier = geometry[3]!.toUpperCase() === 'K' ? 1024
      : geometry[3]!.toUpperCase() === 'M' ? 1024 * 1024
        : geometry[3]!.toUpperCase() === 'G' ? 1024 * 1024 * 1024
          : 1;
    const segmentBytes = Number(geometry[1]) * Number(geometry[2]) * multiplier;
    if (!Number.isSafeInteger(segmentBytes) || segmentBytes <= 0) {
      throw new Error(`DFU internal-flash geometry size is invalid: ${segment}`);
    }
    capacityBytes += segmentBytes;
    if (!Number.isSafeInteger(capacityBytes)) throw new Error('DFU internal-flash capacity exceeds the safe integer range');
  }
  if (capacityBytes < EVIDENCE_V1_FIRMWARE_RELEASE.sizeBytes) {
    throw new Error(`DFU internal-flash capacity ${capacityBytes} is smaller than the historical image`);
  }
}

function isChronological(timestamps: readonly string[]): boolean {
  for (let index = 1; index < timestamps.length; index++) {
    if (Date.parse(timestamps[index]!) < Date.parse(timestamps[index - 1]!)) return false;
  }
  return true;
}

function sameInstant(left: string, right: string): boolean {
  return Date.parse(left) === Date.parse(right);
}
