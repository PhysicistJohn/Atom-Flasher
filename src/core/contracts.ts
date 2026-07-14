import { z } from 'zod';

export const FIRMWARE_SOURCE_COMMIT = 'c97938697b6c7485e7cab50bca9af76996b7d671' as const;
export const ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT = 'c5dd31fd4679c15ba92ff46a6e258c1e3516ff0c' as const;
export const ZS407_SHIPPED_FIRMWARE_VERSION = 'tinySA4_v1.4-217-gc5dd31f' as const;
export const SUPPORTED_ZS407_FIRMWARE_REVISIONS = Object.freeze({
  c5dd31f: ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT,
  c979386: FIRMWARE_SOURCE_COMMIT,
} as const);
export type SupportedZs407FirmwareRevision = keyof typeof SUPPORTED_ZS407_FIRMWARE_REVISIONS;

export const OEM_ZS407_FIRMWARE_RELEASE = Object.freeze({
  product: 'tinySA Ultra / Ultra+',
  version: 'tinySA4_v1.4-224-gc979386',
  revision: 'c979386' as const,
  sourceCommit: FIRMWARE_SOURCE_COMMIT,
  publishedAt: '2026-05-06T11:33:12.000Z',
  downloadUrl: 'http://dfu.tinydevices.org/tinySA4/DFU/tinySA4_v1.4-224-gc979386.bin',
  sha256: '3c9847ff4d7b80561df2f2f1030a112703a083409ffb2ee11361b2413b7c1e41',
  sizeBytes: 185_704,
  transportIntegrity: 'pinned-sha256' as const,
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

export interface DeviceIdentity {
  model: 'tinySA Ultra+ ZS407';
  hardwareVersion: string;
  firmwareVersion: string;
  firmwareReportedRevision: string;
  firmwareSourceCommit?: typeof FIRMWARE_SOURCE_COMMIT | typeof ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT;
  firmwareQualification: 'supported-oem' | 'custom-unqualified';
  firmwareWarning?: string;
  port: PortCandidate;
  usbIdentityVerified: true;
}

export interface DeviceTelemetry {
  batteryMillivolts: number;
  deviceId: number;
  capturedAt: string;
}

export interface DeviceSnapshot {
  connection: 'disconnected' | 'connecting' | 'identifying' | 'ready' | 'disconnecting' | 'faulted';
  identity?: DeviceIdentity;
  telemetry?: DeviceTelemetry;
  connectedAt?: string;
  fault?: string;
}

export interface DeviceDiagnostics {
  identity: DeviceIdentity;
  firmwareVersionResponse: string;
  infoLines: readonly string[];
  commands: readonly string[];
  telemetry: DeviceTelemetry;
  capturedAt: string;
}

export interface ScreenFrame {
  width: typeof SCREEN_WIDTH;
  height: typeof SCREEN_HEIGHT;
  format: 'rgb565le';
  pixels: Uint8Array;
  capturedAt: string;
}

export const firmwareUpdatePhaseSchema = z.enum([
  'idle', 'available', 'downloading', 'verified', 'awaiting-dfu', 'ready-to-flash',
  'flashing', 'reconnecting', 'completed', 'up-to-date', 'custom-firmware', 'failed',
]);
export const firmwareWriteDispositionSchema = z.enum(['not-started', 'started', 'completed', 'indeterminate']);
export const firmwareFlashProgressStageSchema = z.enum(['preparing', 'erasing', 'writing', 'verifying-reboot', 'complete']);

const releaseSchema = z.object({
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

export const usbContinuitySchema = z.object({
  cdcPath: z.string().min(1),
  cdcSerialNumber: z.string().min(1).optional(),
  vendorId: z.literal(TINYSA_USB_VENDOR_ID),
  productId: z.literal(TINYSA_USB_PRODUCT_ID),
  deviceId: z.number().int().nonnegative(),
}).strict();

export const dfuIdentitySchema = z.object({
  path: z.string().min(1),
  devnum: z.string().regex(/^\d+$/),
  serial: z.string().min(1),
  alt: z.literal(0),
  name: z.string().startsWith('@Internal Flash'),
  fingerprint: z.string().min(1),
  targetLine: z.string().min(1),
}).strict();
export type DfuIdentity = z.infer<typeof dfuIdentitySchema>;

const supportedOemCurrentFirmwareSchema = z.union([
  z.object({
    version: z.literal(ZS407_SHIPPED_FIRMWARE_VERSION),
    revision: z.literal('c5dd31f'),
    sourceCommit: z.literal(ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT),
    qualification: z.literal('supported-oem'),
  }).strict(),
  z.object({
    version: z.literal(OEM_ZS407_FIRMWARE_RELEASE.version),
    revision: z.literal(OEM_ZS407_FIRMWARE_RELEASE.revision),
    sourceCommit: z.literal(OEM_ZS407_FIRMWARE_RELEASE.sourceCommit),
    qualification: z.literal('supported-oem'),
  }).strict(),
]);

export const firmwareUpdateStateSchema = z.object({
  phase: firmwareUpdatePhaseSchema,
  target: releaseSchema,
  updateAvailable: z.boolean(),
  current: z.union([
    supportedOemCurrentFirmwareSchema,
    z.object({
      version: z.string().min(1),
      revision: z.string().regex(/^[a-f0-9]{7,40}$/),
      qualification: z.literal('custom-unqualified'),
    }).strict(),
  ]).optional(),
  artifact: z.object({
    sizeBytes: z.literal(OEM_ZS407_FIRMWARE_RELEASE.sizeBytes),
    sha256: z.literal(OEM_ZS407_FIRMWARE_RELEASE.sha256),
    verifiedAt: z.string().datetime(),
  }).strict().optional(),
  dfuUtility: z.object({ available: z.boolean(), version: z.string().min(1).optional() }).strict(),
  dfuDevice: z.object({ detected: z.boolean(), count: z.number().int().nonnegative(), identity: dfuIdentitySchema.optional() }).strict(),
  preparation: z.object({
    id: z.string().uuid(),
    preparedAt: z.string().datetime(),
    batteryMillivolts: z.number().int().positive(),
    deviceId: z.number().int().nonnegative(),
    screenSha256: z.string().regex(/^[a-f0-9]{64}$/),
    selfTestPassed: z.literal(true),
    selfTestProcedure: z.literal(OEM_ZS407_SELF_TEST_PROCEDURE.id),
    configurationDisposition: z.enum(['new-device-unchanged', 'backup-complete-and-recalibration-accepted']),
    rfPortsDisconnected: z.literal(true),
    onlyUsbDeviceConnected: z.literal(true),
    usbContinuity: usbContinuitySchema,
  }).strict().optional(),
  writeDisposition: firmwareWriteDispositionSchema,
  writeStartedAt: z.string().datetime().optional(),
  writeCompletedAt: z.string().datetime().optional(),
  flashProgress: z.object({
    stage: firmwareFlashProgressStageSchema,
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
export type FirmwareUpdateState = z.infer<typeof firmwareUpdateStateSchema>;

export const firmwareUpdateJournalSchema = z.object({
  schemaVersion: z.literal(1),
  targetVersion: z.literal(OEM_ZS407_FIRMWARE_RELEASE.version),
  writtenAt: z.string().datetime(),
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

export const firmwareFlashRequestSchema = z.object({
  preparationId: z.string().uuid(),
  confirmation: z.literal('FLASH VERIFIED OEM FIRMWARE'),
}).strict();
export type FirmwareFlashRequest = z.infer<typeof firmwareFlashRequestSchema>;

export function initialFirmwareUpdateState(): FirmwareUpdateState {
  return {
    phase: 'idle',
    target: OEM_ZS407_FIRMWARE_RELEASE,
    updateAvailable: false,
    dfuUtility: { available: false },
    dfuDevice: { detected: false, count: 0 },
    writeDisposition: 'not-started',
  };
}
