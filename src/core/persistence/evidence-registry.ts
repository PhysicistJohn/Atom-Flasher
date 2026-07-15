import { z } from 'zod';
import {
  EVIDENCE_V1_FIRMWARE_RELEASE,
  completedLedgerV1Schema,
  firmwareUpdateJournalV1Schema,
  preflightRecordV1Schema,
  transactionAuditV1Schema,
  type CompletedLedgerV1,
  type FirmwareUpdateJournalV1,
  type TransactionAuditV1,
} from './evidence-schemas-v1.js';
import {
  completedLedgerV2Schema,
  firmwareUpdateJournalV2Schema,
  preflightRecordV2Schema,
  transactionAuditV2Schema,
  type CompletedLedgerV2,
  type FirmwareUpdateJournalV2,
  type PreflightRecordV2,
  type TransactionAuditV2,
} from './evidence-schemas-v2.js';

export type HistoricalFirmwareJournal = FirmwareUpdateJournalV1 | FirmwareUpdateJournalV2;
export type HistoricalCompletedLedger = CompletedLedgerV1 | CompletedLedgerV2;
export type HistoricalPreflightRecord = z.infer<typeof preflightRecordV1Schema> | PreflightRecordV2;
export type HistoricalTransactionAudit = TransactionAuditV1 | TransactionAuditV2;

/** Append-only parser registry. Version 2 is target-dynamic and self-contained. */
export const FIRMWARE_EVIDENCE_SCHEMA_REGISTRY = Object.freeze({
  1: Object.freeze({ schemaVersion: 1 as const, targetBinding: 'pinned-release-version' as const }),
  2: Object.freeze({ schemaVersion: 2 as const, targetBinding: 'embedded-target-sha256' as const }),
} as const);

export function evidenceDefinitionForSchemaVersion(schemaVersion: number) {
  if (!Object.hasOwn(FIRMWARE_EVIDENCE_SCHEMA_REGISTRY, schemaVersion)) return undefined;
  return FIRMWARE_EVIDENCE_SCHEMA_REGISTRY[schemaVersion as keyof typeof FIRMWARE_EVIDENCE_SCHEMA_REGISTRY];
}

/**
 * Append-only mapping from target release to its durable evidence schema.
 * Never edit or remove an existing entry. A new release must allocate a new
 * schema version, add immutable schemas in a new module, and append its parser
 * dispatch below even if the new data shape initially looks identical.
 */
export const FIRMWARE_EVIDENCE_RELEASE_REGISTRY = Object.freeze({
  [EVIDENCE_V1_FIRMWARE_RELEASE.version]: Object.freeze({
    schemaVersion: 1 as const,
    release: EVIDENCE_V1_FIRMWARE_RELEASE,
  }),
} as const);

export function evidenceDefinitionForTargetVersion(targetVersion: string) {
  if (!Object.hasOwn(FIRMWARE_EVIDENCE_RELEASE_REGISTRY, targetVersion)) return undefined;
  return FIRMWARE_EVIDENCE_RELEASE_REGISTRY[targetVersion as keyof typeof FIRMWARE_EVIDENCE_RELEASE_REGISTRY];
}

export function requireEvidenceDefinitionForWriter(targetVersion: string) {
  const definition = evidenceDefinitionForTargetVersion(targetVersion);
  if (!definition) throw new Error(`Firmware target ${targetVersion} has no append-only durable evidence schema; allocate and register a new schema version before writing`);
  return definition;
}

export function parseHistoricalFirmwareJournal(value: unknown): HistoricalFirmwareJournal {
  const header = z.object({ schemaVersion: z.number().int() }).passthrough().parse(value);
  if (header.schemaVersion === 1) return firmwareUpdateJournalV1Schema.parse(value);
  if (header.schemaVersion === 2) return firmwareUpdateJournalV2Schema.parse(value);
  throw new Error(`Unsupported firmware journal schemaVersion ${header.schemaVersion}`);
}

export function parseHistoricalCompletedLedger(value: unknown): HistoricalCompletedLedger {
  const journal = parseHistoricalFirmwareJournal(value);
  if (journal.schemaVersion === 1) return completedLedgerV1Schema.parse(journal);
  return completedLedgerV2Schema.parse(journal);
}

export function parseHistoricalPreflightRecord(value: unknown): HistoricalPreflightRecord {
  const header = z.object({ schemaVersion: z.number().int() }).passthrough().parse(value);
  if (header.schemaVersion === 1) return preflightRecordV1Schema.parse(value);
  if (header.schemaVersion === 2) return preflightRecordV2Schema.parse(value);
  throw new Error(`Unsupported firmware preflight schemaVersion ${header.schemaVersion}`);
}

export function parseHistoricalTransactionAudit(value: unknown): HistoricalTransactionAudit {
  const header = z.object({ schemaVersion: z.number().int() }).passthrough().parse(value);
  if (header.schemaVersion === 1) return transactionAuditV1Schema.parse(value);
  if (header.schemaVersion === 2) return transactionAuditV2Schema.parse(value);
  throw new Error(`Unsupported firmware result-audit schemaVersion ${header.schemaVersion}`);
}
