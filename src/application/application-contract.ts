import { z } from 'zod';
import {
  deviceSnapshotSchema,
  firmwareUpdateStateSchema,
  isoTimestampSchema,
  portCandidateSchema,
  uuidSchema,
  type DeviceSnapshot,
  type FirmwareUpdateState,
} from '../core/contracts.js';

export const applicationOperationSchema = z.enum([
  'scan-devices',
  'connect-device',
  'disconnect-device',
  'recover-device',
  'select-oem-target',
  'select-local-firmware-target',
  'download-firmware',
  'prepare-firmware',
  'detect-dfu',
  'refresh-prerequisites',
  'flash-firmware',
  'safe-disconnect',
]);
export type ApplicationOperation = z.infer<typeof applicationOperationSchema>;

export const applicationCriticalSectionSchema = z.enum([
  'none',
  'native-file-selection',
  'native-confirmation',
  'firmware-write-or-verification',
]);
export type ApplicationCriticalSection = z.infer<typeof applicationCriticalSectionSchema>;

export const applicationAdmissionSchema = z.enum(['accepting', 'draining', 'closed']);
export type ApplicationAdmission = z.infer<typeof applicationAdmissionSchema>;

export const applicationActivitySchema = z.object({
  operation: applicationOperationSchema.optional(),
  criticalSection: applicationCriticalSectionSchema,
  admission: applicationAdmissionSchema,
}).strict();
export type ApplicationActivity = z.infer<typeof applicationActivitySchema>;

export const allowedActionsSchema = z.object({
  scanDevices: z.boolean(),
  connectDevice: z.boolean(),
  disconnectDevice: z.boolean(),
  recoverDevice: z.boolean(),
  selectOemTarget: z.boolean(),
  selectLocalFirmwareTarget: z.boolean(),
  download: z.boolean(),
  prepare: z.boolean(),
  detectDfu: z.boolean(),
  refreshPrerequisites: z.boolean(),
  flash: z.boolean(),
}).strict();
export type AllowedActions = z.infer<typeof allowedActionsSchema>;

export function deriveAllowedActions(
  device: DeviceSnapshot,
  update: FirmwareUpdateState,
  activity: ApplicationActivity,
): AllowedActions {
  const idle = activity.admission === 'accepting'
    && activity.criticalSection === 'none'
    && activity.operation === undefined;
  const notStarted = update.writeDisposition === 'not-started';
  // A recovered prepared custom state has no serializable descriptor
  // capability. It must be re-admitted before DFU actions can be advertised.
  const preparedRetry = update.phase === 'failed'
    && update.target.kind === 'oem'
    && Boolean(update.preparation)
    && Boolean(update.artifact);
  const recoverableUnpreparedFailure = update.phase === 'failed'
    && notStarted
    && !update.preparation;
  const mayChooseNewTarget = idle && notStarted && !update.preparation;
  const mayRebindPreparedCustomTarget = idle
    && notStarted
    && update.target.kind === 'local-custom'
    && Boolean(update.preparation);
  return {
    scanDevices: idle && device.connection === 'disconnected' && !update.preparation,
    connectDevice: idle
      && device.connection === 'disconnected'
      && !update.preparation
      && (update.phase !== 'failed' || recoverableUnpreparedFailure),
    disconnectDevice: idle && (device.connection === 'ready' || device.connection === 'faulted'),
    recoverDevice: idle && device.connection === 'faulted',
    selectOemTarget: mayChooseNewTarget && update.target.kind !== 'oem',
    selectLocalFirmwareTarget: (mayChooseNewTarget && device.connection === 'ready') || mayRebindPreparedCustomTarget,
    download: idle
      && notStarted
      && update.target.kind === 'oem'
      && device.connection === 'ready'
      && !update.preparation
      && (update.phase === 'available' || update.phase === 'failed')
      && update.updateAvailable,
    prepare: idle && notStarted && device.connection === 'ready' && update.phase === 'verified' && !update.preparation,
    detectDfu: idle
      && notStarted
      && device.connection !== 'faulted'
      && (update.phase === 'awaiting-dfu' || preparedRetry),
    refreshPrerequisites: idle
      && notStarted
      && Boolean(update.preparation)
      && ['awaiting-dfu', 'ready-to-flash', 'failed'].includes(update.phase)
      && (update.phase !== 'failed' || update.target.kind === 'oem'),
    flash: idle
      && notStarted
      && device.connection !== 'faulted'
      && update.phase === 'ready-to-flash'
      && update.dfuUtility.available
      && update.dfuDevice.detected
      && update.dfuDevice.count === 1
      && Boolean(update.dfuDevice.identity)
      && Boolean(update.preparation),
  };
}

export const applicationSnapshotSchema = z.object({
  schemaVersion: z.literal(2),
  instanceId: uuidSchema,
  sequence: z.number().int().positive(),
  capturedAt: isoTimestampSchema,
  activity: applicationActivitySchema,
  discovery: z.object({
    candidates: z.array(portCandidateSchema).readonly(),
    scannedAt: isoTimestampSchema.optional(),
  }).strict(),
  device: deviceSnapshotSchema,
  update: firmwareUpdateStateSchema,
  allowedActions: allowedActionsSchema,
}).strict().superRefine((snapshot, context) => {
  const expected = deriveAllowedActions(snapshot.device, snapshot.update, snapshot.activity);
  for (const key of Object.keys(expected) as (keyof AllowedActions)[]) {
    if (snapshot.allowedActions[key] !== expected[key]) {
      context.addIssue({ code: 'custom', path: ['allowedActions', key], message: `${key} does not match application policy` });
    }
  }
});
export type ApplicationSnapshot = z.infer<typeof applicationSnapshotSchema>;

export const applicationActionResultSchema = z.object({
  outcome: z.enum(['completed', 'cancelled']),
  snapshot: applicationSnapshotSchema,
}).strict();
export type ApplicationActionResult = z.infer<typeof applicationActionResultSchema>;
