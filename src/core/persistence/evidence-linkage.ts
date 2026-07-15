import { isDeepStrictEqual } from 'node:util';
import type { z } from 'zod';
import {
  durableLockV1Schema,
} from './evidence-schemas-v1.js';
import type {
  HistoricalFirmwareJournal,
  HistoricalPreflightRecord,
  HistoricalTransactionAudit,
} from './evidence-registry.js';

type DurableLockV1 = z.infer<typeof durableLockV1Schema>;
type WriteLockV1 = Extract<DurableLockV1, { purpose: 'firmware-write' }>;
type AuditStage = HistoricalTransactionAudit['stage'];
type DfuIdentityEvidence = Extract<HistoricalTransactionAudit, { stage: 'write-started' }>['value']['dfuIdentity'];

export interface JournalLinkageEvidence {
  kind: 'active journal' | 'completed ledger';
  path: string;
  sha256: string;
  journal: HistoricalFirmwareJournal;
}

export interface PreflightLinkageEvidence {
  path: string;
  sha256: string;
  record: HistoricalPreflightRecord;
}

export interface AuditLinkageEvidence {
  path: string;
  sha256: string;
  record: HistoricalTransactionAudit;
}

export interface WriteLockLinkageEvidence {
  path: string;
  lock: WriteLockV1;
}

export interface EvidenceLinkageInput {
  active: JournalLinkageEvidence | undefined;
  ledgers: readonly JournalLinkageEvidence[];
  preflights: readonly PreflightLinkageEvidence[];
  audits: readonly AuditLinkageEvidence[];
  writeLock: WriteLockLinkageEvidence | undefined;
}

/**
 * Checks relationships among already schema-valid historical records.
 *
 * Every comparison is derived from the evidence itself. In particular, this
 * module never imports the active firmware release: changing today's release
 * must not reinterpret yesterday's write history.
 */
export function inspectEvidenceLinkage(input: EvidenceLinkageInput): string[] {
  const issues: string[] = [];
  const journals = [...(input.active ? [input.active] : []), ...input.ledgers];
  const journalsByPreparation = groupBy(journals.filter(hasPreparation), (item) => preparationId(item));
  const preflightsByPreparation = groupBy(input.preflights, (item) => item.record.preparation.id.toLowerCase());
  const auditsByPreparation = groupBy(input.audits, (item) => item.record.value.preparationId.toLowerCase());

  inspectCompletedWriteUniqueness(input.ledgers, issues);

  for (const [id, supports] of journalsByPreparation) {
    if (supports.length > 1) {
      issues.push(`Preparation ${id} is claimed by multiple journal/ledger records: ${supports.map((item) => item.path).join(', ')}`);
    }
    const preflights = preflightsByPreparation.get(id) ?? [];
    if (preflights.length === 0) {
      for (const support of supports) issues.push(`Missing preflight record for ${describeSupport(support)}`);
    } else {
      if (preflights.length > 1) {
        issues.push(`Preparation ${id} has duplicate preflight records: ${preflights.map((item) => item.path).join(', ')}`);
      }
      for (const support of supports) {
        for (const preflight of preflights) inspectPreflightRelationship(preflight, support, issues);
      }
    }

    const audits = auditsByPreparation.get(id) ?? [];
    const byStage = groupBy(audits, (item) => item.record.stage);
    for (const [stage, copies] of byStage) {
      if (copies.length > 1) {
        issues.push(`Preparation ${id} has duplicate ${stage} audits: ${copies.map((item) => item.path).join(', ')}`);
      }
    }
    inspectAuditSequence(id, byStage, issues);
    for (const support of supports) {
      inspectRequiredStages(support, byStage, issues);
      for (const audit of audits) inspectAuditRelationship(audit, support, issues);
    }
  }

  for (const preflight of input.preflights) {
    const id = preflight.record.preparation.id.toLowerCase();
    if (!journalsByPreparation.has(id)) {
      issues.push(`Orphan preflight record ${preflight.path} has no matching active journal or completed ledger`);
    }
    inspectPreflightSelfConsistency(preflight, issues);
  }

  for (const audit of input.audits) {
    const id = audit.record.value.preparationId.toLowerCase();
    if (!journalsByPreparation.has(id)) {
      issues.push(`Orphan ${audit.record.stage} audit ${audit.path} has no matching active journal or completed ledger`);
    }
  }

  inspectWriteLock(input.writeLock, input.active, input.audits, issues);
  return [...new Set(issues)];
}

function inspectAuditSequence(
  preparationId: string,
  auditsByStage: ReadonlyMap<AuditStage, readonly AuditLinkageEvidence[]>,
  issues: string[],
): void {
  const starts = auditsByStage.get('write-started') ?? [];
  const writes = auditsByStage.get('write-complete') ?? [];
  const verifications = auditsByStage.get('verified-complete') ?? [];
  for (const started of starts) {
    if (started.record.stage !== 'write-started') continue;
    for (const completed of writes) {
      if (completed.record.stage !== 'write-complete') continue;
      if (!isDeepStrictEqual(started.record.value.dfuIdentity, completed.record.value.dfuIdentity)) {
        issues.push(`Preparation ${preparationId} has inconsistent DFU identities in ${started.path} and ${completed.path}`);
      }
      if (before(completed.record.value.writeCompletedAt, started.record.value.writeStartedAt)) {
        issues.push(`Preparation ${preparationId} has a write-complete audit that precedes its write-started audit`);
      }
    }
  }
  for (const completed of writes) {
    if (completed.record.stage !== 'write-complete') continue;
    for (const verified of verifications) {
      if (verified.record.stage !== 'verified-complete') continue;
      if (!sameInstant(completed.record.value.writeCompletedAt, verified.record.value.writeCompletedAt)) {
        issues.push(`Preparation ${preparationId} has inconsistent write-completion timestamps in ${completed.path} and ${verified.path}`);
      }
      if (before(verified.record.value.completedAt, completed.record.value.writeCompletedAt)) {
        issues.push(`Preparation ${preparationId} has a verified-complete audit that precedes write completion`);
      }
    }
  }
}

function inspectCompletedWriteUniqueness(ledgers: readonly JournalLinkageEvidence[], issues: string[]): void {
  const byDeviceAndTarget = groupBy(ledgers.filter(hasPreparation), (item) => {
    const state = item.journal.state;
    return `${state.preparation!.deviceId}\u0000${journalTargetKey(item.journal)}`;
  });
  for (const copies of byDeviceAndTarget.values()) {
    if (copies.length < 2) continue;
    const state = copies[0]!.journal.state;
    issues.push(
      `Duplicate completed writes exist for device ${state.preparation!.deviceId} and historical target ${journalTargetLabel(copies[0]!.journal)}: `
      + copies.map((item) => item.path).join(', '),
    );
  }
}

function inspectPreflightSelfConsistency(preflight: PreflightLinkageEvidence, issues: string[]): void {
  const { artifact, identity, preparation, telemetry } = preflight.record;
  const label = `Preflight record ${preflight.path}`;
  if (preparation.deviceId !== preparation.usbContinuity.deviceId) {
    issues.push(`${label} has inconsistent preparation and USB-continuity device IDs`);
  }
  if (preparation.deviceId !== telemetry.deviceId) {
    issues.push(`${label} has inconsistent preparation and telemetry device IDs`);
  }
  if (preparation.batteryMillivolts !== telemetry.batteryMillivolts) {
    issues.push(`${label} has inconsistent preparation and telemetry battery readings`);
  }
  if (preparation.usbContinuity.cdcPath !== identity.port.path
    || preparation.usbContinuity.cdcSerialNumber !== identity.port.serialNumber
    || preparation.usbContinuity.vendorId !== identity.port.vendorId?.toLowerCase()
    || preparation.usbContinuity.productId !== identity.port.productId?.toLowerCase()) {
    issues.push(`${label} has inconsistent prepared and diagnosed USB identities`);
  }
  if (after(artifact.verifiedAt, telemetry.capturedAt)) {
    issues.push(`${label} has telemetry captured before artifact verification`);
  }
  if (after(telemetry.capturedAt, preparation.preparedAt)) {
    issues.push(`${label} has preparation timestamp before diagnostic telemetry`);
  }
}

function inspectPreflightRelationship(
  preflight: PreflightLinkageEvidence,
  support: JournalLinkageEvidence,
  issues: string[],
): void {
  const state = support.journal.state;
  const label = `Preflight record ${preflight.path}`;
  if (!state.preparation) return;
  if (!isDeepStrictEqual(preflight.record.preparation, state.preparation)) {
    issues.push(`${label} does not match the preparation embedded in ${describeSupport(support)}`);
  }
  if (!state.artifact) {
    issues.push(`${describeSupport(support)} has preparation evidence but no verified artifact`);
  } else if (!isDeepStrictEqual(preflight.record.artifact, state.artifact)) {
    issues.push(`${label} artifact does not match ${describeSupport(support)}`);
  }
  if (preflight.record.schemaVersion !== support.journal.schemaVersion
    || preflightTargetKey(preflight.record) !== journalTargetKey(support.journal)
    || state.target.version !== preflight.record.target.version) {
    issues.push(`${label} target does not match the historical target declared by ${describeSupport(support)}`);
  }
  if (support.journal.schemaVersion === 2 && preflight.record.schemaVersion === 2) {
    const expectedIntent = preflight.record.target.kind === 'local-custom'
      ? 'install-custom'
      : preflight.record.identity.firmwareQualification === 'custom-unqualified' ? 'restore-oem' : 'update-oem';
    if (support.journal.state.writeIntent !== expectedIntent) {
      issues.push(`${label} source identity does not support the write intent in ${describeSupport(support)}`);
    }
  }
  if (after(state.preparation.preparedAt, support.journal.writtenAt)) {
    issues.push(`${describeSupport(support)} was written before its preparation timestamp`);
  }
  if (state.artifact && after(state.artifact.verifiedAt, state.preparation.preparedAt)) {
    issues.push(`${describeSupport(support)} prepared the device before its artifact was verified`);
  }
}

function inspectRequiredStages(
  support: JournalLinkageEvidence,
  auditsByStage: ReadonlyMap<AuditStage, readonly AuditLinkageEvidence[]>,
  issues: string[],
): void {
  for (const stage of requiredStages(support.journal)) {
    if (!(auditsByStage.get(stage)?.length)) {
      issues.push(`Missing ${stage} audit for ${describeSupport(support)}`);
    }
  }
}

function requiredStages(journal: HistoricalFirmwareJournal): AuditStage[] {
  const state = journal.state;
  const stages: AuditStage[] = [];
  if (state.writeDisposition === 'started' || state.writeDisposition === 'completed' || state.writeStartedAt) {
    stages.push('write-started');
  }
  if (state.writeDisposition === 'completed' || state.writeCompletedAt) stages.push('write-complete');
  if (state.phase === 'completed' || state.completedAt) stages.push('verified-complete');
  return stages;
}

function inspectAuditRelationship(
  audit: AuditLinkageEvidence,
  support: JournalLinkageEvidence,
  issues: string[],
): void {
  const { journal } = support;
  const state = journal.state;
  const record = audit.record;
  const label = `${titleStage(record.stage)} audit ${audit.path}`;

  if (record.schemaVersion !== journal.schemaVersion || auditTargetKey(record) !== journalTargetKey(journal)) {
    issues.push(`${label} target does not match the historical target declared by ${describeSupport(support)}`);
  }

  if (record.stage === 'write-started') {
    if (!['started', 'completed'].includes(state.writeDisposition)) {
      issues.push(`${label} conflicts with journal disposition ${state.writeDisposition}`);
    }
    if (!state.writeStartedAt || !sameInstant(record.value.writeStartedAt, state.writeStartedAt)) {
      issues.push(`${label} timestamp does not match ${describeSupport(support)}`);
    }
    if (state.preparation && before(record.value.writeStartedAt, state.preparation.preparedAt)) {
      issues.push(`${label} precedes device preparation`);
    }
    inspectDfuIdentity(record.value.dfuIdentity, support, label, issues);
  }

  if (record.stage === 'write-complete') {
    if (state.writeDisposition !== 'completed') {
      issues.push(`${label} lacks a completed journal disposition`);
    }
    if (!state.writeCompletedAt || !sameInstant(record.value.writeCompletedAt, state.writeCompletedAt)) {
      issues.push(`${label} timestamp does not match ${describeSupport(support)}`);
    }
    if (state.writeStartedAt && before(record.value.writeCompletedAt, state.writeStartedAt)) {
      issues.push(`${label} precedes write start`);
    }
    inspectDfuIdentity(record.value.dfuIdentity, support, label, issues);
  }

  if (record.stage === 'verified-complete') {
    if (state.writeDisposition !== 'completed'
      || !['completed', 'failed'].includes(state.phase)
      || !state.completedAt
      || state.flashProgress?.stage !== 'complete') {
      issues.push(`${label} lacks a verified completed journal`);
    }
    if (!state.writeCompletedAt || !sameInstant(record.value.writeCompletedAt, state.writeCompletedAt)) {
      issues.push(`${label} write-completion timestamp does not match ${describeSupport(support)}`);
    }
    if (!state.completedAt || !sameInstant(record.value.completedAt, state.completedAt)) {
      issues.push(`${label} verification timestamp does not match ${describeSupport(support)}`);
    }
    if (before(record.value.completedAt, record.value.writeCompletedAt)) {
      issues.push(`${label} verifies the device before write completion`);
    }
    if (state.preparation && record.value.deviceId !== state.preparation.deviceId) {
      issues.push(`${label} device ID does not match ${describeSupport(support)}`);
    }
    const expectedSerial = state.preparation?.usbContinuity.cdcSerialNumber;
    if (expectedSerial && record.value.identity.port.serialNumber !== expectedSerial) {
      issues.push(`${label} CDC serial does not match the preflight device`);
    }
  }

  const relevantTimestamp = record.stage === 'write-started'
    ? record.value.writeStartedAt
    : record.stage === 'write-complete'
      ? record.value.writeCompletedAt
      : record.value.completedAt;
  if (after(relevantTimestamp, journal.writtenAt)) {
    issues.push(`${label} timestamp is later than ${describeSupport(support)} write time`);
  }
}

function inspectDfuIdentity(
  identity: DfuIdentityEvidence,
  support: JournalLinkageEvidence,
  label: string,
  issues: string[],
): void {
  const expected = support.journal.state.dfuDevice.identity;
  if (expected && !isDeepStrictEqual(identity, expected)) {
    issues.push(`${label} DFU identity does not match ${describeSupport(support)}`);
  }
  const canonical = JSON.stringify({ path: identity.path, devnum: identity.devnum, serial: identity.serial, alt: identity.alt, name: identity.name });
  if (identity.fingerprint !== canonical) issues.push(`${label} contains a DFU fingerprint inconsistent with its identity fields`);
}

function inspectWriteLock(
  evidence: WriteLockLinkageEvidence | undefined,
  active: JournalLinkageEvidence | undefined,
  audits: readonly AuditLinkageEvidence[],
  issues: string[],
): void {
  if (!evidence || !active) return;
  const { lock } = evidence;
  const preparation = active.journal.state.preparation;
  const label = `Firmware write lock ${evidence.path}`;
  if (!preparation || lock.preparationId.toLowerCase() !== preparation.id.toLowerCase()) {
    issues.push(`${label} preparation ID does not match the active journal`);
  }
  if (active.journal.state.writeDisposition === 'not-started') {
    issues.push(`${label} conflicts with a not-started active journal`);
  }
  const journalDfu = active.journal.state.dfuDevice.identity;
  if (journalDfu && !isDeepStrictEqual(lock.dfuIdentity, journalDfu)) {
    issues.push(`${label} DFU identity does not match the active journal`);
  }
  const relatedAudits = audits.filter((item) => item.record.value.preparationId.toLowerCase() === lock.preparationId.toLowerCase());
  for (const audit of relatedAudits) {
    if (audit.record.stage === 'verified-complete') continue;
    if (!isDeepStrictEqual(lock.dfuIdentity, audit.record.value.dfuIdentity)) {
      issues.push(`${label} DFU identity does not match ${audit.record.stage} audit ${audit.path}`);
    }
  }
  if (active.journal.state.writeStartedAt && after(lock.acquiredAt, active.journal.state.writeStartedAt)) {
    issues.push(`${label} was acquired after the active journal says the write started`);
  }
}

function hasPreparation(item: JournalLinkageEvidence): boolean {
  return item.journal.state.preparation !== undefined;
}

function preparationId(item: JournalLinkageEvidence): string {
  return item.journal.state.preparation!.id.toLowerCase();
}

function describeSupport(item: JournalLinkageEvidence): string {
  return `${item.kind} ${item.path}`;
}

function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const grouped = new Map<K, T[]>();
  for (const item of items) {
    const value = key(item);
    grouped.set(value, [...(grouped.get(value) ?? []), item]);
  }
  return grouped;
}

function sameInstant(left: string, right: string): boolean {
  return Date.parse(left) === Date.parse(right);
}

function before(left: string, right: string): boolean {
  return Date.parse(left) < Date.parse(right);
}

function after(left: string, right: string): boolean {
  return Date.parse(left) > Date.parse(right);
}

function titleStage(stage: AuditStage): string {
  return `${stage[0]!.toUpperCase()}${stage.slice(1)}`;
}

function journalTargetKey(journal: HistoricalFirmwareJournal): string {
  return journal.schemaVersion === 1
    ? `v1:${journal.targetVersion}`
    : `v2:${journal.targetId}:${journal.targetSha256}`;
}

function journalTargetLabel(journal: HistoricalFirmwareJournal): string {
  return journal.schemaVersion === 1 ? journal.targetVersion : `${journal.targetId} (${journal.state.target.version})`;
}

function preflightTargetKey(record: HistoricalPreflightRecord): string {
  return record.schemaVersion === 1
    ? `v1:${record.target.version}`
    : `v2:${record.target.targetId}:${record.targetSha256}`;
}

function auditTargetKey(record: HistoricalTransactionAudit): string {
  return record.schemaVersion === 1
    ? `v1:${record.target.version}`
    : `v2:${record.target.targetId}:${record.targetSha256}`;
}
