import { parseJsonObject, collectFirmwareEvidence, errorMessage, sha256Bytes, type EvidenceFile } from './durable-files.js';
import {
  COMPLETED_LEDGER_DIRECTORIES,
  ACTIVE_JOURNAL_FILENAMES,
  JOURNAL_LOCK_FILENAME,
  PREFLIGHT_FILENAME_REGEXP,
  RESULT_AUDIT_FILENAME_REGEXP,
  WRITE_LOCK_FILENAME,
  parseCompletedLedgerRelativePath,
} from './evidence-layout.js';
import {
  durableLockV1Schema,
  EVIDENCE_V1_FIRMWARE_RELEASE,
} from './evidence-schemas-v1.js';
import {
  inspectEvidenceLinkage,
  type AuditLinkageEvidence,
  type JournalLinkageEvidence,
  type PreflightLinkageEvidence,
  type WriteLockLinkageEvidence,
} from './evidence-linkage.js';
import {
  parseHistoricalCompletedLedger,
  parseHistoricalFirmwareJournal,
  parseHistoricalPreflightRecord,
  parseHistoricalTransactionAudit,
} from './evidence-registry.js';

export type ArtifactVerifier = (bytes: Uint8Array) => void;

export interface EvidenceInspectionPolicy {
  /**
   * Include the replaceable artifact cache in the audit. Transaction recovery
   * disables this: cache availability is re-established by FirmwareArtifactStore
   * before write admission and is not part of the append-only evidence graph.
   */
  inspectArtifactCache?: boolean;
  /** Defaults to immutable evidence-v1 byte-length and SHA-256 verification. */
  verifyArtifact?: ArtifactVerifier;
}

/**
 * Audits every durable write-history relationship without consulting the
 * currently selected firmware release. Historical evidence chooses its own
 * immutable reader by schemaVersion/targetVersion.
 */
export async function inspectFirmwareSafetyEvidence(
  directory: string,
  policy: EvidenceInspectionPolicy = {},
): Promise<string[]> {
  const issues: string[] = [];
  const evidence = await collectFirmwareEvidence(directory, issues);
  const journals = evidence.filter((item) => ACTIVE_JOURNAL_FILENAMES.includes(
    item.relativePath as typeof ACTIVE_JOURNAL_FILENAMES[number],
  ));
  if (journals.length > 1) issues.push(`Multiple active firmware journals exist in ${directory}: ${journals.map((item) => item.name).join(', ')}`);
  const journal = journals.length === 1 ? journals[0] : undefined;
  const writeLocks = evidence.filter((item) => item.relativePath === WRITE_LOCK_FILENAME);
  const journalLocks = evidence.filter((item) => item.relativePath === JOURNAL_LOCK_FILENAME);
  if (writeLocks.length && !journal) issues.push(`Orphan firmware write lock has no active journal in ${directory}`);
  if (journalLocks.length) issues.push(`Durable firmware journal mutex requires manual inspection in ${directory}`);
  let parsedWriteLock: WriteLockLinkageEvidence | undefined;
  for (const lock of [...writeLocks, ...journalLocks]) {
    try {
      const parsed = durableLockV1Schema.parse(parseJsonObject(lock.bytes, 'firmware lock'));
      const expectedPurpose = lock.relativePath === WRITE_LOCK_FILENAME ? 'firmware-write' : 'journal-mutation';
      if (parsed.purpose !== expectedPurpose) throw new Error(`lock purpose ${parsed.purpose} does not match reserved filename`);
      if (parsed.purpose === 'firmware-write') parsedWriteLock = { path: lock.path, lock: parsed };
    }
    catch (value) { issues.push(`Malformed firmware lock ${lock.path}: ${errorMessage(value)}`); }
  }

  let active: JournalLinkageEvidence | undefined;
  if (journal) {
    try {
      active = {
        kind: 'active journal', path: journal.path, sha256: journal.sha256,
        journal: parseHistoricalFirmwareJournal(parseJsonObject(journal.bytes, 'journal')),
      };
    }
    catch (value) { issues.push(`Malformed active journal ${journal.path}: ${errorMessage(value)}`); }
  }

  const ledgers = collectCompletedLedgerEvidence(evidence, issues);
  const preflights = collectPreflightRecords(evidence, issues);
  const audits = collectTransactionAudits(evidence, issues);
  if (policy.inspectArtifactCache !== false) {
    inspectCanonicalActiveArtifact(evidence, active, policy.verifyArtifact ?? verifyHistoricalV1Artifact, issues);
  }
  if (active && ['started', 'completed'].includes(active.journal.state.writeDisposition) && !parsedWriteLock) {
    issues.push(`Active journal ${active.path} records a write without its firmware write lock`);
  }
  issues.push(...inspectEvidenceLinkage({ active, ledgers, preflights, audits, writeLock: parsedWriteLock }));
  inspectVerifiedCompletionIdentity(active, ledgers, audits, issues);
  return [...new Set(issues)];
}

function collectCompletedLedgerEvidence(evidence: readonly EvidenceFile[], issues: string[]): JournalLinkageEvidence[] {
  const records: JournalLinkageEvidence[] = [];
  const byPreparation = new Map<string, EvidenceFile>();
  for (const item of evidence) {
    if (!COMPLETED_LEDGER_DIRECTORIES.some((directory) => item.relativePath.startsWith(`${directory}/`)
      || item.relativePath.startsWith(`${directory}\\`))) continue;
    const identity = parseCompletedLedgerRelativePath(item.relativePath);
    if (!identity) {
      issues.push(`Malformed completed ledger ${item.path}: filename must identify its device and preparation`);
      continue;
    }
    try {
      const parsed = parseHistoricalCompletedLedger(parseJsonObject(item.bytes, 'completed ledger'));
      if (parsed.schemaVersion !== identity.schemaVersion) throw new Error('schema version does not match its completed-ledger directory');
      const preparation = parsed.state.preparation!;
      if (preparation.deviceId !== identity.deviceId || preparation.id.toLowerCase() !== identity.preparationId) {
        throw new Error('filename does not match the completed transaction identity');
      }
      const preparationKey = preparation.id.toLowerCase();
      const previous = byPreparation.get(preparationKey);
      if (previous && previous.sha256 !== item.sha256) throw new Error(`preparation conflicts with completed ledger ${previous.path}`);
      if (previous) throw new Error(`preparation is duplicated by completed ledger ${previous.path}`);
      byPreparation.set(preparationKey, item);
      records.push({ kind: 'completed ledger', path: item.path, sha256: item.sha256, journal: parsed });
    } catch (value) {
      issues.push(`Malformed completed ledger ${item.path}: ${errorMessage(value)}`);
    }
  }
  return records;
}

function collectPreflightRecords(evidence: readonly EvidenceFile[], issues: string[]): PreflightLinkageEvidence[] {
  const records: PreflightLinkageEvidence[] = [];
  for (const item of evidence) {
    if (item.relativePath !== item.name) continue;
    const match = item.name.match(PREFLIGHT_FILENAME_REGEXP);
    if (!item.name.toLowerCase().startsWith('preflight-')) continue;
    if (!match) {
      issues.push(`Malformed preflight record ${item.path}: filename must contain one preparation UUID`);
      continue;
    }
    try {
      const parsed = parseHistoricalPreflightRecord(parseJsonObject(item.bytes, 'preflight record'));
      if (parsed.preparation.id.toLowerCase() !== match[1]!.toLowerCase()) throw new Error('preparation ID does not match its filename');
      records.push({ path: item.path, sha256: item.sha256, record: parsed });
    } catch (value) {
      issues.push(`Malformed preflight record ${item.path}: ${errorMessage(value)}`);
    }
  }
  return records;
}

function collectTransactionAudits(evidence: readonly EvidenceFile[], issues: string[]): AuditLinkageEvidence[] {
  const records: AuditLinkageEvidence[] = [];
  for (const item of evidence) {
    if (item.relativePath !== item.name) continue;
    const match = item.name.match(RESULT_AUDIT_FILENAME_REGEXP);
    if (!item.name.toLowerCase().startsWith('result-')) continue;
    if (!match) {
      issues.push(`Malformed transaction audit ${item.path}: filename must contain one preparation UUID and stage`);
      continue;
    }
    const preparationId = match[1]!.toLowerCase();
    const filenameStage = match[2]!.toLowerCase();
    try {
      const parsed = parseHistoricalTransactionAudit(parseJsonObject(item.bytes, 'transaction audit'));
      if (parsed.stage !== filenameStage) throw new Error('stage does not match its filename');
      if (parsed.value.preparationId.toLowerCase() !== preparationId) throw new Error('preparation ID does not match its filename');
      records.push({ path: item.path, sha256: item.sha256, record: parsed });
    } catch (value) {
      issues.push(`Malformed ${filenameStage} audit ${item.path}: ${errorMessage(value)}`);
    }
  }
  return records;
}

function inspectVerifiedCompletionIdentity(
  active: JournalLinkageEvidence | undefined,
  ledgers: readonly JournalLinkageEvidence[],
  audits: readonly AuditLinkageEvidence[],
  issues: string[],
): void {
  const supports = [...(active ? [active] : []), ...ledgers];
  for (const audit of audits) {
    if (audit.record.stage !== 'verified-complete') continue;
    const preparationId = audit.record.value.preparationId.toLowerCase();
    for (const support of supports) {
      if (support.journal.state.preparation?.id.toLowerCase() !== preparationId) continue;
      const current = support.journal.state.current;
      const identity = audit.record.value.identity;
      if (!current
        || current.version !== identity.firmwareVersion
        || current.revision !== identity.firmwareReportedRevision
        || current.qualification !== identity.firmwareQualification) {
        issues.push(`Verified-complete audit ${audit.path} firmware identity does not match ${support.kind} ${support.path}`);
      }
    }
  }
}

function inspectCanonicalActiveArtifact(
  evidence: readonly EvidenceFile[],
  active: JournalLinkageEvidence | undefined,
  verifyArtifact: ArtifactVerifier,
  issues: string[],
): void {
  if (!active?.journal.state.artifact || active.journal.schemaVersion !== 1) return;
  const filename = `${EVIDENCE_V1_FIRMWARE_RELEASE.version}.bin`;
  const artifact = evidence.find((item) => item.relativePath === filename);
  if (!artifact) {
    issues.push(`Active journal ${active.path} declares a verified artifact but canonical artifact ${filename} is missing`);
    return;
  }
  try { verifyArtifact(artifact.bytes); }
  catch (value) { issues.push(`Canonical artifact ${artifact.path} failed verification: ${errorMessage(value)}`); }
}

function verifyHistoricalV1Artifact(bytes: Uint8Array): void {
  if (bytes.byteLength !== EVIDENCE_V1_FIRMWARE_RELEASE.sizeBytes) {
    throw new Error(`artifact has ${bytes.byteLength} bytes, expected ${EVIDENCE_V1_FIRMWARE_RELEASE.sizeBytes}`);
  }
  const actual = sha256Bytes(bytes);
  if (actual !== EVIDENCE_V1_FIRMWARE_RELEASE.sha256) {
    throw new Error(`artifact SHA-256 ${actual} does not match pinned ${EVIDENCE_V1_FIRMWARE_RELEASE.sha256}`);
  }
}
