import { z } from 'zod';
import activeReleaseManifestJson from '../../contracts/releases/oem-zs407-c979386-v1.json';

const activeReleaseManifestSchema = z.object({
  $schema: z.literal('../schemas/firmware-release-v1.schema.json'),
  $id: z.literal('https://physicistjohn.github.io/tinysa-flasher/contracts/releases/oem-zs407-c979386-v1.json'),
  manifestVersion: z.literal(1),
  releaseId: z.literal('oem-zs407-c979386'),
  product: z.string().min(1),
  version: z.string().min(1),
  revision: z.string().regex(/^[a-f0-9]{7,40}$/),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  publishedAt: z.string().datetime(),
  downloadUrl: z.string().regex(/^https?:\/\//),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().positive(),
  transportIntegrity: z.literal('pinned-sha256'),
}).strict();

const ACTIVE_RELEASE_MANIFEST = Object.freeze(activeReleaseManifestSchema.parse(activeReleaseManifestJson));

export const FIRMWARE_SOURCE_COMMIT = ACTIVE_RELEASE_MANIFEST.sourceCommit as 'c97938697b6c7485e7cab50bca9af76996b7d671';
export const ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT = 'c5dd31fd4679c15ba92ff46a6e258c1e3516ff0c' as const;
export const ZS407_SHIPPED_FIRMWARE_VERSION = 'tinySA4_v1.4-217-gc5dd31f' as const;
export const SUPPORTED_ZS407_FIRMWARE_REVISIONS = Object.freeze({
  c5dd31f: ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT,
  c979386: FIRMWARE_SOURCE_COMMIT,
} as const);
export type SupportedZs407FirmwareRevision = keyof typeof SUPPORTED_ZS407_FIRMWARE_REVISIONS;

export const OEM_ZS407_FIRMWARE_RELEASE = Object.freeze({
  product: ACTIVE_RELEASE_MANIFEST.product as 'tinySA Ultra / Ultra+',
  version: ACTIVE_RELEASE_MANIFEST.version as 'tinySA4_v1.4-224-gc979386',
  revision: ACTIVE_RELEASE_MANIFEST.revision as 'c979386',
  sourceCommit: FIRMWARE_SOURCE_COMMIT,
  publishedAt: ACTIVE_RELEASE_MANIFEST.publishedAt as '2026-05-06T11:33:12.000Z',
  downloadUrl: ACTIVE_RELEASE_MANIFEST.downloadUrl as 'http://dfu.tinydevices.org/tinySA4/DFU/tinySA4_v1.4-224-gc979386.bin',
  sha256: ACTIVE_RELEASE_MANIFEST.sha256 as '3c9847ff4d7b80561df2f2f1030a112703a083409ffb2ee11361b2413b7c1e41',
  sizeBytes: ACTIVE_RELEASE_MANIFEST.sizeBytes as 185_704,
  transportIntegrity: ACTIVE_RELEASE_MANIFEST.transportIntegrity,
});

/** Active OEM write target. Source commit is manifest provenance, not a value observed from the device CLI. */
export const OEM_ZS407_FIRMWARE_TARGET = Object.freeze({
  kind: 'oem' as const,
  targetId: ACTIVE_RELEASE_MANIFEST.releaseId as 'oem-zs407-c979386',
  ...OEM_ZS407_FIRMWARE_RELEASE,
});

export const SUPPORTED_ZS407_OEM_FIRMWARE_VERSIONS = Object.freeze({
  [ZS407_SHIPPED_FIRMWARE_VERSION]: Object.freeze({
    version: ZS407_SHIPPED_FIRMWARE_VERSION,
    revision: 'c5dd31f' as const,
    sourceCommit: ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT,
  }),
  [OEM_ZS407_FIRMWARE_RELEASE.version]: Object.freeze({
    version: OEM_ZS407_FIRMWARE_RELEASE.version,
    revision: OEM_ZS407_FIRMWARE_RELEASE.revision,
    sourceCommit: OEM_ZS407_FIRMWARE_RELEASE.sourceCommit,
  }),
});
export type SupportedZs407OemFirmwareVersion = keyof typeof SUPPORTED_ZS407_OEM_FIRMWARE_VERSIONS;

export function lookupSupportedZs407OemFirmware(version: string) {
  if (!Object.hasOwn(SUPPORTED_ZS407_OEM_FIRMWARE_VERSIONS, version)) return undefined;
  return SUPPORTED_ZS407_OEM_FIRMWARE_VERSIONS[version as SupportedZs407OemFirmwareVersion];
}

export const OEM_ZS407_SELF_TEST_PROCEDURE = Object.freeze({
  id: 'tinySA4-zs407-cal-rf-v1' as const,
  fixture: 'short-50-ohm-coax-cal-to-rf' as const,
  connectorA: 'CAL' as const,
  connectorB: 'RF' as const,
  menuPath: 'CONFIG > SELF TEST' as const,
  guideUrl: 'https://tinysa.org/wiki/pmwiki.php?n=TinySA4.MenuTree' as const,
});

export const TINYSA_USB_VENDOR_ID = '0483' as const;
export const TINYSA_USB_PRODUCT_ID = '5740' as const;
export const TINYSA_DFU_PRODUCT_ID = 'df11' as const;
export const SCREEN_WIDTH = 480 as const;
export const SCREEN_HEIGHT = 320 as const;
export const SCREEN_BYTES = SCREEN_WIDTH * SCREEN_HEIGHT * 2;

export const isoTimestampSchema = z.string().datetime();
export const uuidSchema = z.string().uuid();

export const portCandidateSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  manufacturer: z.string().min(1).optional(),
  serialNumber: z.string().min(1).optional(),
  vendorId: z.string().regex(/^[a-f0-9]{4}$/i).optional(),
  productId: z.string().regex(/^[a-f0-9]{4}$/i).optional(),
  usbMatch: z.enum(['exact-zs407-cdc', 'unverified-serial']),
}).strict().superRefine((candidate, context) => {
  if (candidate.usbMatch === 'exact-zs407-cdc'
    && (candidate.vendorId?.toLowerCase() !== TINYSA_USB_VENDOR_ID || candidate.productId?.toLowerCase() !== TINYSA_USB_PRODUCT_ID)) {
    context.addIssue({ code: 'custom', message: 'Exact ZS407 candidates require USB 0483:5740' });
  }
});
export type PortCandidate = z.infer<typeof portCandidateSchema>;
export const portCandidateArraySchema = z.array(portCandidateSchema);
export type PortCandidateArray = z.infer<typeof portCandidateArraySchema>;

export const deviceIdentitySchema = z.object({
  model: z.literal('tinySA Ultra+ ZS407'),
  hardwareVersion: z.string().min(1),
  firmwareVersion: z.string().min(1),
  firmwareReportedRevision: z.string().regex(/^[a-f0-9]{7,40}$/),
  firmwareSourceCommit: z.union([
    z.literal(FIRMWARE_SOURCE_COMMIT),
    z.literal(ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT),
  ]).optional(),
  firmwareQualification: z.enum(['supported-oem', 'custom-unqualified']),
  firmwareWarning: z.string().min(1).optional(),
  port: portCandidateSchema,
  usbIdentityVerified: z.literal(true),
}).strict().superRefine((identity, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message });
  if (identity.port.usbMatch !== 'exact-zs407-cdc'
    || identity.port.vendorId?.toLowerCase() !== TINYSA_USB_VENDOR_ID
    || identity.port.productId?.toLowerCase() !== TINYSA_USB_PRODUCT_ID) {
    issue('A verified device identity requires exact USB 0483:5740 evidence');
  }
  const supported = lookupSupportedZs407OemFirmware(identity.firmwareVersion);
  if (identity.firmwareQualification === 'supported-oem') {
    if (!supported
      || supported.revision !== identity.firmwareReportedRevision) {
      issue('Supported OEM identity requires an exact recognized version and device-reported revision');
    }
    // Older device adapters populate this from the pinned manifest lookup. It
    // is compatibility provenance, never treated as a device-observed value.
    if (identity.firmwareSourceCommit && identity.firmwareSourceCommit !== supported?.sourceCommit) {
      issue('Supported OEM compatibility source commit must match manifest provenance');
    }
    if (identity.firmwareWarning !== undefined) issue('Supported OEM identity cannot carry a custom-firmware warning');
  } else {
    if (identity.firmwareSourceCommit !== undefined) issue('Custom unqualified identity cannot claim an OEM source commit');
    if (!identity.firmwareWarning) issue('Custom unqualified identity requires an explicit warning');
  }
});
export type DeviceIdentity = z.infer<typeof deviceIdentitySchema>;

export const deviceTelemetrySchema = z.object({
  batteryMillivolts: z.number().int().min(0).max(10_000),
  deviceId: z.number().int().nonnegative(),
  capturedAt: isoTimestampSchema,
}).strict();
export type DeviceTelemetry = z.infer<typeof deviceTelemetrySchema>;

export const deviceSnapshotSchema = z.object({
  connection: z.enum(['disconnected', 'connecting', 'identifying', 'ready', 'disconnecting', 'faulted']),
  identity: deviceIdentitySchema.optional(),
  telemetry: deviceTelemetrySchema.optional(),
  connectedAt: isoTimestampSchema.optional(),
  fault: z.string().min(1).optional(),
}).strict().superRefine((snapshot, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message });
  const hasIdentity = snapshot.identity !== undefined;
  const hasTelemetry = snapshot.telemetry !== undefined;
  const hasConnectedAt = snapshot.connectedAt !== undefined;
  const hasReadyProof = hasIdentity && hasTelemetry && hasConnectedAt;
  const hasAnyReadyProof = hasIdentity || hasTelemetry || hasConnectedAt;
  if (snapshot.connection === 'ready') {
    if (!hasReadyProof) issue('Ready device state requires identity, telemetry, and connection time');
    if (snapshot.fault) issue('Ready device state cannot carry a fault');
    return;
  }
  if (snapshot.connection === 'faulted') {
    if (!snapshot.fault) issue('Faulted device state requires a diagnostic message');
    if (hasAnyReadyProof) issue('Faulted device state cannot retain trusted ready-session evidence');
    return;
  }
  if (snapshot.connection === 'disconnecting') {
    const leavingReady = hasReadyProof && !snapshot.fault;
    const leavingFault = Boolean(snapshot.fault) && !hasAnyReadyProof;
    if (!leavingReady && !leavingFault) issue('Disconnecting state must originate from a complete ready session or a fault');
    return;
  }
  if (hasAnyReadyProof) issue(`${snapshot.connection} device state cannot carry trusted ready-session evidence`);
  if (snapshot.connection !== 'disconnected' && snapshot.fault) issue(`${snapshot.connection} device state cannot carry a fault`);
});
export type DeviceSnapshot = z.infer<typeof deviceSnapshotSchema>;

export const deviceDiagnosticsSchema = z.object({
  identity: deviceIdentitySchema,
  firmwareVersionResponse: z.string().min(1),
  infoLines: z.array(z.string().min(1)).min(1).readonly(),
  commands: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(1).readonly(),
  telemetry: deviceTelemetrySchema,
  capturedAt: isoTimestampSchema,
}).strict();
export type DeviceDiagnostics = z.infer<typeof deviceDiagnosticsSchema>;

export const screenFrameSchema = z.object({
  width: z.literal(SCREEN_WIDTH),
  height: z.literal(SCREEN_HEIGHT),
  format: z.literal('rgb565le'),
  pixels: z.instanceof(Uint8Array).refine((pixels) => pixels.byteLength === SCREEN_BYTES, {
    message: `Screen frame must contain exactly ${SCREEN_BYTES} RGB565 bytes`,
  }),
  capturedAt: isoTimestampSchema,
}).strict();
export type ScreenFrame = z.infer<typeof screenFrameSchema>;

export const firmwareUpdatePhaseSchema = z.enum([
  'idle', 'available', 'downloading', 'verified', 'awaiting-dfu', 'ready-to-flash',
  'flashing', 'reconnecting', 'completed', 'up-to-date', 'custom-firmware', 'failed',
]);
export const firmwareWriteDispositionSchema = z.enum(['not-started', 'started', 'completed', 'indeterminate']);
export const firmwareFlashProgressStageSchema = z.enum(['preparing', 'erasing', 'writing', 'verifying-reboot', 'complete']);

export const firmwareReleaseSchema = z.object({
  product: z.literal(OEM_ZS407_FIRMWARE_RELEASE.product),
  version: z.literal(OEM_ZS407_FIRMWARE_RELEASE.version),
  revision: z.literal(OEM_ZS407_FIRMWARE_RELEASE.revision),
  sourceCommit: z.literal(OEM_ZS407_FIRMWARE_RELEASE.sourceCommit),
  publishedAt: z.literal(OEM_ZS407_FIRMWARE_RELEASE.publishedAt),
  downloadUrl: z.literal(OEM_ZS407_FIRMWARE_RELEASE.downloadUrl),
  sha256: z.literal(OEM_ZS407_FIRMWARE_RELEASE.sha256),
  sizeBytes: z.literal(OEM_ZS407_FIRMWARE_RELEASE.sizeBytes),
  transportIntegrity: z.literal(OEM_ZS407_FIRMWARE_RELEASE.transportIntegrity),
}).strict();
export type FirmwareRelease = z.infer<typeof firmwareReleaseSchema>;

const firmwareTargetCommonShape = {
  targetId: z.string().min(1).max(160).regex(/^[a-z0-9][a-z0-9._-]+$/),
  product: z.literal(OEM_ZS407_FIRMWARE_RELEASE.product),
  version: z.string().trim().min(1).max(160).regex(/^[^\r\n]+$/),
  revision: z.string().regex(/^[a-f0-9]{7,40}$/),
  /** Manifest provenance only; post-flash device proof uses version + reported revision. */
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().min(1).max(245_760),
};

export const oemFirmwareTargetSchema = z.object({
  kind: z.literal('oem'),
  ...firmwareTargetCommonShape,
  targetId: z.literal('oem-zs407-c979386'),
  version: z.literal(OEM_ZS407_FIRMWARE_RELEASE.version),
  revision: z.literal(OEM_ZS407_FIRMWARE_RELEASE.revision),
  sourceCommit: z.literal(OEM_ZS407_FIRMWARE_RELEASE.sourceCommit),
  sha256: z.literal(OEM_ZS407_FIRMWARE_RELEASE.sha256),
  sizeBytes: z.literal(OEM_ZS407_FIRMWARE_RELEASE.sizeBytes),
  publishedAt: z.literal(OEM_ZS407_FIRMWARE_RELEASE.publishedAt),
  downloadUrl: z.literal(OEM_ZS407_FIRMWARE_RELEASE.downloadUrl),
  transportIntegrity: z.literal('pinned-sha256'),
}).strict();

export const localCustomFirmwareTargetSchema = z.object({
  kind: z.literal('local-custom'),
  ...firmwareTargetCommonShape,
  sizeBytes: z.number().int().min(8 * 1024).max(245_760),
  targetId: z.string().regex(/^custom-zs407-[a-f0-9]{64}$/),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  hardwareQualification: z.enum(['qualified', 'unqualified']),
  qualificationEvidenceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  buildProvenance: z.object({
    sourceRepository: z.literal('PhysicistJohn/TinySA_Firmware'),
    chibiosCommit: z.string().regex(/^[a-f0-9]{40}$/),
    sourceDateEpoch: z.number().int().nonnegative(),
    toolchain: z.string().trim().min(1).max(200),
    reproducibleCleanBuilds: z.literal(true),
    simulationQualification: z.enum(['passed', 'not-run']),
  }).strict(),
  transportIntegrity: z.literal('local-manifest-sha256'),
}).strict().superRefine((target, context) => {
  if (target.targetId !== `custom-zs407-${target.sha256}`) {
    context.addIssue({ code: 'custom', message: 'Custom target ID must be content-addressed by the admitted firmware SHA-256' });
  }
  if (lookupSupportedZs407OemFirmware(target.version)
    || Object.hasOwn(SUPPORTED_ZS407_FIRMWARE_REVISIONS, target.revision)) {
    context.addIssue({ code: 'custom', message: 'A custom target cannot claim a reserved OEM version or revision' });
  }
  if (target.version.match(/-g([a-f0-9]{7,40})$/)?.[1] !== target.revision) {
    context.addIssue({ code: 'custom', message: 'Custom target version suffix must exactly match its reported revision' });
  }
  if (!target.sourceCommit.startsWith(target.revision)) {
    context.addIssue({ code: 'custom', message: 'Custom target source commit must begin with its reported revision' });
  }
  if (target.hardwareQualification === 'qualified' && !target.qualificationEvidenceSha256) {
    context.addIssue({ code: 'custom', message: 'A qualified custom target must retain its immutable qualification-evidence SHA-256' });
  }
  if (target.hardwareQualification === 'unqualified' && target.qualificationEvidenceSha256) {
    context.addIssue({ code: 'custom', message: 'An unqualified custom target cannot claim qualification evidence' });
  }
});

export const firmwareTargetSchema = z.discriminatedUnion('kind', [
  oemFirmwareTargetSchema,
  localCustomFirmwareTargetSchema,
]);
export type FirmwareTarget = z.infer<typeof firmwareTargetSchema>;
export type LocalCustomFirmwareTarget = z.infer<typeof localCustomFirmwareTargetSchema>;

export const usbContinuitySchema = z.object({
  cdcPath: z.string().min(1),
  cdcSerialNumber: z.string().min(1).optional(),
  vendorId: z.literal(TINYSA_USB_VENDOR_ID),
  productId: z.literal(TINYSA_USB_PRODUCT_ID),
  deviceId: z.number().int().nonnegative(),
}).strict();

export function canonicalDfuFingerprint(identity: { path: string; devnum: string; serial: string; alt: 0; name: string }): string {
  return JSON.stringify({ path: identity.path, devnum: identity.devnum, serial: identity.serial, alt: identity.alt, name: identity.name });
}

export function inspectInternalFlashDescriptorContract(name: string): { startAddress: number; capacityBytes: number } {
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

export const dfuIdentitySchema = z.object({
  path: z.string().min(1).regex(/^[^"\r\n]+$/),
  devnum: z.string().regex(/^\d+$/),
  serial: z.string().min(1).regex(/^[^"\r\n]+$/),
  alt: z.literal(0),
  name: z.string().startsWith('@Internal Flash').regex(/^[^"\r\n]+$/),
  fingerprint: z.string().min(1),
  targetLine: z.string().min(1).max(20_000),
}).strict().superRefine((identity, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message });
  try { inspectInternalFlashDescriptorContract(identity.name); }
  catch (value) { issue(value instanceof Error ? value.message : String(value)); }
  if (identity.fingerprint !== canonicalDfuFingerprint(identity)) issue('DFU fingerprint is not the canonical identity serialization');
  const target = identity.targetLine;
  const path = target.match(/\bpath="([^"]+)"/i)?.[1];
  const devnum = target.match(/\bdevnum=(\d+)\b/i)?.[1];
  const serial = target.match(/\bserial="([^"]*)"/i)?.[1];
  const alt = target.match(/\balt=(\d+)\b/i)?.[1];
  const name = target.match(/\bname="([^"]+)"/i)?.[1];
  if (!/Found DFU:\s*\[0483:df11\]/i.test(target)
    || path !== identity.path
    || devnum !== identity.devnum
    || serial !== identity.serial
    || alt !== '0'
    || name !== identity.name) {
    issue('DFU target line does not exactly support its persisted canonical identity');
  }
});
export type DfuIdentity = z.infer<typeof dfuIdentitySchema>;

export const firmwareArtifactSchema = z.object({
  targetId: z.string().min(1).max(160).optional(),
  sizeBytes: z.number().int().min(1).max(245_760),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  verifiedAt: isoTimestampSchema,
}).strict();
export type FirmwareArtifact = z.infer<typeof firmwareArtifactSchema>;

export const dfuUtilityStateSchema = z.object({
  available: z.boolean(),
  version: z.string().min(1).optional(),
}).strict().superRefine((utility, context) => {
  if (utility.available && !/^(?:dfu-util\s+)?0\.11$/.test(utility.version ?? '')) {
    context.addIssue({ code: 'custom', message: 'Available DFU utility must report exact version 0.11' });
  }
  if (!utility.available && utility.version !== undefined) {
    context.addIssue({ code: 'custom', message: 'Unavailable DFU utility cannot report a version' });
  }
});
export type DfuUtilityState = z.infer<typeof dfuUtilityStateSchema>;

export const dfuDeviceStateSchema = z.object({
  detected: z.boolean(),
  count: z.number().int().nonnegative(),
  identity: dfuIdentitySchema.optional(),
}).strict().superRefine((device, context) => {
  if (device.detected && (device.count !== 1 || !device.identity)) {
    context.addIssue({ code: 'custom', message: 'Detected DFU state requires exactly one persisted identity' });
  }
  if (!device.detected && device.identity) {
    context.addIssue({ code: 'custom', message: 'Undetected DFU state cannot retain a trusted identity' });
  }
});
export type DfuDeviceState = z.infer<typeof dfuDeviceStateSchema>;

export const firmwarePreparationSchema = z.object({
  id: uuidSchema,
  preparedAt: isoTimestampSchema,
  batteryMillivolts: z.number().int().min(4_000),
  deviceId: z.number().int().nonnegative(),
  screenSha256: z.string().regex(/^[a-f0-9]{64}$/),
  selfTestPassed: z.literal(true),
  selfTestProcedure: z.literal(OEM_ZS407_SELF_TEST_PROCEDURE.id),
  configurationDisposition: z.enum(['new-device-unchanged', 'backup-complete-and-recalibration-accepted']),
  rfPortsDisconnected: z.literal(true),
  onlyUsbDeviceConnected: z.literal(true),
  usbContinuity: usbContinuitySchema,
}).strict().superRefine((preparation, context) => {
  if (preparation.deviceId !== preparation.usbContinuity.deviceId) {
    context.addIssue({ code: 'custom', message: 'Preparation and USB continuity device IDs must match' });
  }
});
export type FirmwarePreparation = z.infer<typeof firmwarePreparationSchema>;

export const firmwareFlashProgressSchema = z.object({
  stage: firmwareFlashProgressStageSchema,
  percent: z.number().int().min(0).max(100),
  stagePercent: z.number().int().min(0).max(100).optional(),
  updatedAt: isoTimestampSchema,
}).strict().superRefine((progress, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message });
  if (progress.stage === 'preparing' && (progress.percent !== 0 || progress.stagePercent !== undefined)) issue('Preparing progress must be zero');
  if (progress.stage === 'erasing' && (progress.percent > 40 || progress.stagePercent === undefined)) issue('Invalid erase progress');
  if (progress.stage === 'writing' && (progress.percent < 40 || progress.percent > 95 || progress.stagePercent === undefined)) issue('Invalid write progress');
  if (progress.stage === 'verifying-reboot' && (progress.percent !== 98 || progress.stagePercent !== 100)) issue('Invalid verification progress');
  if (progress.stage === 'complete' && (progress.percent !== 100 || progress.stagePercent !== 100)) issue('Invalid completed progress');
});
export type FirmwareFlashProgress = z.infer<typeof firmwareFlashProgressSchema>;

const supportedOemCurrentFirmwareSchema = z.union([
  z.object({
    version: z.literal(ZS407_SHIPPED_FIRMWARE_VERSION),
    revision: z.literal('c5dd31f'),
    sourceCommit: z.literal(ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT).optional(),
    qualification: z.literal('supported-oem'),
  }).strict(),
  z.object({
    version: z.literal(OEM_ZS407_FIRMWARE_RELEASE.version),
    revision: z.literal(OEM_ZS407_FIRMWARE_RELEASE.revision),
    sourceCommit: z.literal(OEM_ZS407_FIRMWARE_RELEASE.sourceCommit).optional(),
    qualification: z.literal('supported-oem'),
  }).strict(),
]);

const observedCurrentFirmwareSchema = z.union([
  supportedOemCurrentFirmwareSchema,
  z.object({
    version: z.string().min(1),
    revision: z.string().regex(/^[a-f0-9]{7,40}$/),
    qualification: z.literal('custom-unqualified'),
  }).strict(),
]);

export const firmwareTargetRelationSchema = z.enum(['unknown', 'same', 'different-supported', 'custom-current']);
export const firmwareWriteIntentSchema = z.enum(['update-oem', 'restore-oem', 'install-custom']);
export type FirmwareTargetRelation = z.infer<typeof firmwareTargetRelationSchema>;
export type FirmwareWriteIntent = z.infer<typeof firmwareWriteIntentSchema>;

export const firmwareUpdateStateSchema = z.object({
  phase: firmwareUpdatePhaseSchema,
  target: firmwareTargetSchema,
  targetRelation: firmwareTargetRelationSchema,
  writeIntent: firmwareWriteIntentSchema.optional(),
  /** @deprecated Compatibility projection. Prefer targetRelation/writeIntent. */
  updateAvailable: z.boolean(),
  current: observedCurrentFirmwareSchema.optional(),
  artifact: firmwareArtifactSchema.optional(),
  dfuUtility: dfuUtilityStateSchema,
  dfuDevice: dfuDeviceStateSchema,
  preparation: firmwarePreparationSchema.optional(),
  writeDisposition: firmwareWriteDispositionSchema,
  writeStartedAt: isoTimestampSchema.optional(),
  writeCompletedAt: isoTimestampSchema.optional(),
  flashProgress: firmwareFlashProgressSchema.optional(),
  completedAt: isoTimestampSchema.optional(),
  continuityWarning: z.string().min(1).optional(),
  warning: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
}).strict().superRefine((state, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message });
  if (state.writeDisposition === 'not-started' && (state.writeStartedAt || state.writeCompletedAt)) issue('A not-started write cannot have write timestamps');
  if (state.writeDisposition === 'started' && (!state.writeStartedAt || state.writeCompletedAt)) issue('A started write requires only writeStartedAt');
  if (state.writeDisposition === 'completed' && (!state.writeStartedAt || !state.writeCompletedAt)) issue('A completed write requires both write timestamps');
  if (state.writeDisposition === 'indeterminate' && state.phase !== 'failed') issue('An indeterminate write disposition must remain failed');
  if (state.completedAt && (!['completed', 'failed'].includes(state.phase)
    || state.writeDisposition !== 'completed'
    || state.flashProgress?.stage !== 'complete')) {
    issue('Post-write verification evidence is legal only in completed state or a later failed state that retains complete write proof');
  }
  if (['flashing', 'reconnecting', 'completed'].includes(state.phase) && state.writeDisposition === 'not-started') issue(`${state.phase} requires durable write evidence`);
  const reportedIdentityMatchesTarget = Boolean(state.current
    && state.current.version === state.target.version
    && state.current.revision === state.target.revision
    && ((state.target.kind === 'oem' && state.current.qualification === 'supported-oem')
      || (state.target.kind === 'local-custom' && state.current.qualification === 'custom-unqualified')));
  const completedCustomWriteProof = state.target.kind === 'local-custom'
    && reportedIdentityMatchesTarget
    && state.writeDisposition === 'completed'
    && Boolean(state.completedAt)
    && state.flashProgress?.stage === 'complete';
  // Custom firmware does not expose a device-side image digest. Matching
  // labels are not byte identity; only this app's completed write evidence can
  // establish an exact custom target.
  const targetMatchesCurrent = state.target.kind === 'oem'
    ? reportedIdentityMatchesTarget
    : completedCustomWriteProof;
  const expectedRelation: FirmwareTargetRelation = !state.current
    ? 'unknown'
    : targetMatchesCurrent
      ? 'same'
      : state.current.qualification === 'supported-oem' ? 'different-supported' : 'custom-current';
  const expectedIntent: FirmwareWriteIntent | undefined = expectedRelation === 'unknown' || expectedRelation === 'same'
    ? undefined
    : state.target.kind === 'local-custom'
      ? 'install-custom'
      : state.current?.qualification === 'custom-unqualified' ? 'restore-oem' : 'update-oem';
  const transactionRetainsIntent = state.writeDisposition === 'completed';
  if (state.targetRelation !== expectedRelation) issue('Target relation must match the observed current firmware and selected target');
  if (!transactionRetainsIntent && state.writeIntent !== expectedIntent) issue('Write intent must match the current firmware and selected target');
  if (transactionRetainsIntent) {
    if (!state.writeIntent) issue('A completed write disposition must retain its admitted write intent');
    if (state.target.kind === 'local-custom' && state.writeIntent !== 'install-custom') issue('A completed custom write must retain install-custom intent');
    if (state.target.kind === 'oem' && state.writeIntent !== 'update-oem' && state.writeIntent !== 'restore-oem') {
      issue('A completed OEM write must retain update-oem or restore-oem intent');
    }
    if (!targetMatchesCurrent && expectedIntent && state.writeIntent !== expectedIntent) {
      issue('A completed but unverified write must retain the intent supported by its source identity');
    }
  }
  const compatibilityUpdateAvailable = expectedRelation !== 'unknown' && expectedRelation !== 'same';
  if (state.updateAvailable !== compatibilityUpdateAvailable) issue('Deprecated updateAvailable must remain a projection of targetRelation');
  if (state.artifact?.targetId && state.artifact.targetId !== state.target.targetId) issue('Verified artifact belongs to a different firmware target');
  if (state.artifact && (state.artifact.sha256 !== state.target.sha256 || state.artifact.sizeBytes !== state.target.sizeBytes)) {
    issue('Verified artifact digest and size must match the selected firmware target');
  }
  if (state.phase === 'custom-firmware' && (!state.current || state.current.qualification !== 'custom-unqualified' || !state.warning)) {
    issue('Legacy custom-firmware state requires an observed custom identity and warning');
  }
  if (state.preparation && !state.artifact) issue('A preparation cannot exist without its verified artifact');
  if (['started', 'completed'].includes(state.writeDisposition) && (!state.preparation || !state.artifact)) {
    issue('Durable write evidence requires the prepared verified artifact');
  }
  if (state.phase === 'idle'
    && (state.current || state.updateAvailable || state.artifact || state.preparation || state.dfuDevice.detected || state.writeDisposition !== 'not-started')) {
    issue('Idle state cannot claim device, artifact, preparation, DFU, or write evidence');
  }
  if ((state.phase === 'available' || state.phase === 'downloading')
    && (!state.current || expectedRelation === 'same' || expectedRelation === 'unknown' || !state.writeIntent
      || state.artifact || state.preparation || state.writeDisposition !== 'not-started'
      || (state.phase === 'downloading' && state.target.kind !== 'oem'))) {
    issue(`${state.phase} requires one different admitted target before artifact verification`);
  }
  if (state.phase === 'verified'
    && (!state.artifact || state.preparation || expectedRelation === 'same' || expectedRelation === 'unknown'
      || !state.writeIntent || state.writeDisposition !== 'not-started')) {
    issue('Verified state requires an exact target artifact and a different ready device before preparation');
  }
  if ((state.phase === 'awaiting-dfu' || state.phase === 'ready-to-flash')
    && (!state.artifact || !state.preparation || expectedRelation === 'same' || expectedRelation === 'unknown'
      || !state.writeIntent || state.writeDisposition !== 'not-started')) {
    issue(`${state.phase} requires one coherent prepared write to a different admitted target`);
  }
  if (state.phase === 'awaiting-dfu' && (state.dfuDevice.detected || state.dfuDevice.count !== 0)) issue('Awaiting-DFU state cannot retain an admitted DFU target');
  if (state.phase === 'ready-to-flash'
    && (!state.dfuUtility.available || !state.dfuDevice.detected || state.dfuDevice.count !== 1 || !state.dfuDevice.identity)) {
    issue('Ready-to-flash requires dfu-util 0.11 and one identified DFU target');
  }
  if (state.phase === 'completed'
    && (state.writeDisposition !== 'completed'
      || !state.completedAt
      || !state.artifact
      || !state.preparation
      || state.updateAvailable
      || !targetMatchesCurrent
      || state.targetRelation !== 'same'
      || !state.dfuUtility.available
      || !state.dfuDevice.detected
      || state.flashProgress?.stage !== 'complete')) {
    issue('Completed state requires the prepared artifact, exact target identity, DFU evidence, and completed verification proof');
  }
  if (state.phase === 'up-to-date'
    && (!targetMatchesCurrent || state.updateAvailable || state.writeIntent || state.preparation || state.writeDisposition !== 'not-started')) {
    issue('Up-to-date state requires an exact selected-target identity with no active preparation');
  }
  if ((state.phase === 'flashing' || state.phase === 'reconnecting')
    && (!state.artifact
      || !state.preparation
      || expectedRelation === 'same'
      || expectedRelation === 'unknown'
      || !state.writeIntent
      || !state.dfuUtility.available
      || !state.dfuDevice.detected
      || state.dfuDevice.count !== 1
      || !state.dfuDevice.identity)) {
    issue(`${state.phase} requires the complete prepared and admitted DFU write context`);
  }
  if (state.phase === 'flashing' && state.writeDisposition !== 'started') issue('Flashing state requires started write disposition');
  if (state.phase === 'reconnecting' && state.writeDisposition !== 'completed') issue('Reconnecting state requires completed write disposition');
  if (state.phase === 'failed' && !state.error) issue('Failed state requires an error diagnostic');
  if (state.artifact && state.preparation && Date.parse(state.preparation.preparedAt) < Date.parse(state.artifact.verifiedAt)) issue('Preparation cannot precede artifact verification');
  if (state.preparation && state.writeStartedAt && Date.parse(state.writeStartedAt) < Date.parse(state.preparation.preparedAt)) issue('Write start cannot precede preparation');
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
});
export type FirmwareUpdateState = z.infer<typeof firmwareUpdateStateSchema>;

export const firmwareUpdateJournalSchema = z.object({
  schemaVersion: z.literal(2),
  targetId: z.string().min(1),
  targetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  writtenAt: isoTimestampSchema,
  state: firmwareUpdateStateSchema,
}).strict();

export const firmwareUpdatePreflightSchema = z.object({
  selfTestPassed: z.literal(true),
  selfTestProcedure: z.literal(OEM_ZS407_SELF_TEST_PROCEDURE.id),
  configurationDisposition: z.enum(['new-device-unchanged', 'backup-complete-and-recalibration-accepted']),
  rfPortsDisconnected: z.literal(true),
  onlyUsbDeviceConnected: z.literal(true),
}).strict();
export type FirmwareUpdatePreflight = z.infer<typeof firmwareUpdatePreflightSchema>;

export const firmwareFlashRequestSchema = z.discriminatedUnion('confirmation', [
  z.object({
    preparationId: uuidSchema,
    confirmation: z.literal('FLASH VERIFIED OEM FIRMWARE'),
  }).strict(),
  z.object({
    preparationId: uuidSchema,
    confirmation: z.literal('FLASH VERIFIED CUSTOM FIRMWARE'),
  }).strict(),
]);
export type FirmwareFlashRequest = z.infer<typeof firmwareFlashRequestSchema>;

export function initialFirmwareUpdateState(target: FirmwareTarget = OEM_ZS407_FIRMWARE_TARGET): FirmwareUpdateState {
  return {
    phase: 'idle',
    target,
    targetRelation: 'unknown',
    updateAvailable: false,
    dfuUtility: { available: false },
    dfuDevice: { detected: false, count: 0 },
    writeDisposition: 'not-started',
  };
}
