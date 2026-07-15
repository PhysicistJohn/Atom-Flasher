import { basename, join, sep } from 'node:path';

/**
 * Durable evidence layout version 1.
 *
 * These names are permanent once released. A later release may add a new
 * layout, but must not reinterpret or rename version-1 evidence: older files
 * are part of the fail-closed write history.
 */
export const FIRMWARE_EVIDENCE_LAYOUT_V1 = Object.freeze({
  schemaVersion: 1,
  journalFilename: 'firmware-update-journal-v1.json',
  completedLedgerDirectory: 'completed-ledger-v1',
  writeLockFilename: 'firmware-write.lock',
  journalLockFilename: 'firmware-journal.lock',
  migrationMarkerFilename: 'legacy-migration-v1.json',
  migrationConflictFilename: 'legacy-migration-conflict-v1.json',
} as const);

/**
 * The active-journal name is versioned independently from the immutable
 * ledger directory.  Version-2 journals embed their complete dynamic target;
 * a version-1 journal keeps its original name and schema for its entire life.
 */
export const FIRMWARE_EVIDENCE_LAYOUT_V2 = Object.freeze({
  schemaVersion: 2,
  journalFilename: 'firmware-update-journal-v2.json',
  completedLedgerDirectory: 'completed-ledger-v2',
} as const);

export const JOURNAL_FILENAME = FIRMWARE_EVIDENCE_LAYOUT_V1.journalFilename;
export const JOURNAL_V2_FILENAME = FIRMWARE_EVIDENCE_LAYOUT_V2.journalFilename;
export const ACTIVE_JOURNAL_FILENAMES = Object.freeze([
  JOURNAL_FILENAME,
  JOURNAL_V2_FILENAME,
] as const);
export const COMPLETED_LEDGER_DIRECTORY = FIRMWARE_EVIDENCE_LAYOUT_V1.completedLedgerDirectory;
export const COMPLETED_LEDGER_V2_DIRECTORY = FIRMWARE_EVIDENCE_LAYOUT_V2.completedLedgerDirectory;
export const COMPLETED_LEDGER_DIRECTORIES = Object.freeze([
  COMPLETED_LEDGER_DIRECTORY,
  COMPLETED_LEDGER_V2_DIRECTORY,
] as const);
export const WRITE_LOCK_FILENAME = FIRMWARE_EVIDENCE_LAYOUT_V1.writeLockFilename;
export const JOURNAL_LOCK_FILENAME = FIRMWARE_EVIDENCE_LAYOUT_V1.journalLockFilename;
export const MIGRATION_MARKER_FILENAME = FIRMWARE_EVIDENCE_LAYOUT_V1.migrationMarkerFilename;
export const MIGRATION_CONFLICT_FILENAME = FIRMWARE_EVIDENCE_LAYOUT_V1.migrationConflictFilename;

export const PREPARATION_ID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
export const PREPARATION_ID_REGEXP = new RegExp(`^${PREPARATION_ID_PATTERN}$`, 'i');
export const PREFLIGHT_FILENAME_REGEXP = new RegExp(`^preflight-(${PREPARATION_ID_PATTERN})\\.json$`, 'i');
export const RESULT_AUDIT_FILENAME_REGEXP = new RegExp(`^result-(${PREPARATION_ID_PATTERN})-([a-z][a-z-]*)\\.json$`, 'i');
export const COMPLETED_LEDGER_FILENAME_REGEXP = new RegExp(`^device-(\\d+)-preparation-(${PREPARATION_ID_PATTERN})\\.json$`, 'i');
export const FIRMWARE_ARTIFACT_FILENAME_REGEXP = /^tinySA4_[A-Za-z0-9_.+-]+\.bin$/;
const RESERVED_PREFLIGHT_FILENAME_REGEXP = /^preflight-.*\.json$/i;
const RESERVED_RESULT_AUDIT_FILENAME_REGEXP = /^result-.*\.json$/i;
export const RESERVED_JOURNAL_FILENAME_REGEXP = /^firmware-update-journal-v(\d+)\.json$/i;
export const RESERVED_COMPLETED_LEDGER_DIRECTORY_REGEXP = /^completed-ledger-v(\d+)$/i;
export const RESERVED_MIGRATION_FILENAME_REGEXP = /^legacy-migration(?:-conflict)?-v(\d+)\.json$/i;

export type TransactionAuditStage = 'write-started' | 'write-complete' | 'verified-complete';

export function preflightFilename(preparationId: string): string {
  requirePreparationId(preparationId);
  return `preflight-${preparationId}.json`;
}

export function resultAuditFilename(preparationId: string, stage: TransactionAuditStage): string {
  requirePreparationId(preparationId);
  return `result-${preparationId}-${stage}.json`;
}

export function completedLedgerFilename(deviceId: number, preparationId: string): string {
  if (!Number.isSafeInteger(deviceId) || deviceId < 0) throw new Error('Completed-ledger device ID must be a nonnegative safe integer');
  requirePreparationId(preparationId);
  return `device-${deviceId}-preparation-${preparationId}.json`;
}

export function completedLedgerPath(rootDirectory: string, deviceId: number, preparationId: string, schemaVersion: 1 | 2 = 1): string {
  const directory = schemaVersion === 1 ? COMPLETED_LEDGER_DIRECTORY : COMPLETED_LEDGER_V2_DIRECTORY;
  return join(rootDirectory, directory, completedLedgerFilename(deviceId, preparationId));
}

export function parseCompletedLedgerRelativePath(relativePath: string): { deviceId: number; preparationId: string; schemaVersion: 1 | 2 } | undefined {
  const schemaVersion = relativePath.startsWith(`${COMPLETED_LEDGER_DIRECTORY}${sep}`) ? 1 as const
    : relativePath.startsWith(`${COMPLETED_LEDGER_V2_DIRECTORY}${sep}`) ? 2 as const : undefined;
  if (!schemaVersion) return undefined;
  const match = basename(relativePath).match(COMPLETED_LEDGER_FILENAME_REGEXP);
  if (!match) return undefined;
  const deviceId = Number(match[1]);
  if (!Number.isSafeInteger(deviceId)) return undefined;
  return { deviceId, preparationId: match[2]!.toLowerCase(), schemaVersion };
}

export function isFirmwareSafetyArtifact(name: string): boolean {
  return RESERVED_JOURNAL_FILENAME_REGEXP.test(name)
    // Reserve the whole namespace. A malformed identifier must be collected
    // and rejected by the inspector, never made invisible by a narrow glob.
    || RESERVED_PREFLIGHT_FILENAME_REGEXP.test(name)
    || RESERVED_RESULT_AUDIT_FILENAME_REGEXP.test(name)
    || FIRMWARE_ARTIFACT_FILENAME_REGEXP.test(name)
    || RESERVED_MIGRATION_FILENAME_REGEXP.test(name)
    || name === WRITE_LOCK_FILENAME
    || name === JOURNAL_LOCK_FILENAME;
}

function requirePreparationId(preparationId: string): void {
  if (!PREPARATION_ID_REGEXP.test(preparationId)) throw new Error('Preparation ID must be a UUID');
}
