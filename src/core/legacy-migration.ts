import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  collectFirmwareEvidence,
  copyEvidenceAtomic,
  ensurePrivateFirmwareDirectory,
  errorMessage,
  parseJsonObject,
  readStableRegularFile,
  syncDirectory,
  writeExclusiveAtomic,
  type EvidenceFile,
} from './persistence/durable-files.js';
import {
  JOURNAL_FILENAME,
  JOURNAL_LOCK_FILENAME,
  MIGRATION_CONFLICT_FILENAME,
  MIGRATION_MARKER_FILENAME,
  WRITE_LOCK_FILENAME,
} from './persistence/evidence-layout.js';
import { inspectFirmwareSafetyEvidence } from './persistence/evidence-inspector.js';
import { migrationConflictV1Schema, migrationMarkerV1Schema, type MigrationMarkerV1 } from './persistence/evidence-schemas-v1.js';

// Compatibility exports keep callers stable while ownership lives in the
// persistence subsystem. Migration now depends on persistence, never vice versa.
export {
  JOURNAL_FILENAME,
  MIGRATION_CONFLICT_FILENAME,
  MIGRATION_MARKER_FILENAME,
} from './persistence/evidence-layout.js';
export { directoryChainToRoot } from './persistence/durable-files.js';
export { inspectFirmwareSafetyEvidence } from './persistence/evidence-inspector.js';

export interface LegacyMigrationResult {
  status: 'none' | 'imported' | 'already-current' | 'conflict';
  sources: readonly string[];
  message?: string;
}

export async function migrateLegacyFirmwareState(targetDirectory: string, legacyDirectories: readonly string[]): Promise<LegacyMigrationResult> {
  await ensurePrivateFirmwareDirectory(targetDirectory);
  const existingConflict = join(targetDirectory, MIGRATION_CONFLICT_FILENAME);
  if (await pathExists(existingConflict)) {
    return { status: 'conflict', sources: [], message: 'A prior legacy migration conflict remains unresolved' };
  }

  let consumed: MigrationMarkerV1 | undefined;
  try { consumed = await readMigrationMarker(join(targetDirectory, MIGRATION_MARKER_FILENAME)); }
  catch (value) {
    const reason = `The durable legacy migration marker is invalid or unreadable: ${errorMessage(value)}. Legacy sources were not reconsidered.`;
    await writeMigrationConflict(targetDirectory, reason, await collectFirmwareEvidence(targetDirectory));
    return { status: 'conflict', sources: [], message: reason };
  }
  if (consumed) return inspectConsumedBaseline(targetDirectory, legacyDirectories, consumed);

  const directories = [...new Set([targetDirectory, ...legacyDirectories])];
  const conflicts: string[] = [];
  const evidence = (await Promise.all(directories.map((directory) => collectFirmwareEvidence(directory, conflicts)))).flat();
  const journals = evidence.filter((item) => item.relativePath === JOURNAL_FILENAME);
  const locks = evidence.filter((item) => item.relativePath === WRITE_LOCK_FILENAME);
  const journalLocks = evidence.filter((item) => item.relativePath === JOURNAL_LOCK_FILENAME);
  if (new Set(journals.map((candidate) => candidate.sha256)).size > 1) conflicts.push('Active firmware journals have different content');
  if (locks.length > 1) conflicts.push(`Multiple firmware write locks exist (${locks.length})`);
  if (journalLocks.length) conflicts.push(`Durable firmware journal mutex evidence requires manual inspection (${journalLocks.length})`);
  for (const lock of locks) {
    if (lock.directory !== targetDirectory) conflicts.push(`Legacy firmware write lock requires manual inspection in ${lock.directory}`);
    if (!journals.some((journal) => journal.directory === lock.directory)) conflicts.push(`Orphan firmware write lock has no journal in ${lock.directory}`);
  }

  const byName = groupByRelativePath(evidence);
  for (const [relativePath, copies] of byName) {
    if (new Set(copies.map((copy) => copy.sha256)).size > 1) conflicts.push(`Safety evidence ${relativePath} has conflicting content`);
  }
  for (const directory of directories) conflicts.push(...await inspectFirmwareSafetyEvidence(directory));

  if (conflicts.length) {
    const reason = `${[...new Set(conflicts)].join('; ')}. No safety history was selected and flashing is locked pending manual inspection.`;
    await writeMigrationConflict(targetDirectory, reason, evidence);
    return { status: 'conflict', sources: evidence.map((item) => item.path), message: reason };
  }

  const legacyEvidence = evidence.filter((item) => item.directory !== targetDirectory);
  try {
    for (const [relativePath, copies] of byName) {
      const source = copies.find((copy) => copy.directory !== targetDirectory);
      if (!source) continue;
      await copyEvidenceAtomic(source, join(targetDirectory, relativePath), targetDirectory);
    }
  } catch (value) {
    conflicts.push(`Safety evidence could not be copied without a collision: ${errorMessage(value)}`);
  }

  const targetEvidence = await collectFirmwareEvidence(targetDirectory, conflicts);
  const targetByPath = new Map(targetEvidence.map((item) => [item.relativePath, item]));
  for (const [relativePath, copies] of byName) {
    const expectedHashes = new Set(copies.map((copy) => copy.sha256));
    const copied = targetByPath.get(relativePath);
    if (!copied) conflicts.push(`Safety evidence ${relativePath} is missing from the migration target`);
    else if (!expectedHashes.has(copied.sha256)) conflicts.push(`Safety evidence ${relativePath} changed while it was migrated`);
  }
  conflicts.push(...await inspectFirmwareSafetyEvidence(targetDirectory));
  if (conflicts.length) {
    const reason = `${[...new Set(conflicts)].join('; ')}. Migrated safety history is locked pending manual inspection.`;
    await writeMigrationConflict(targetDirectory, reason, await collectFirmwareEvidence(targetDirectory));
    return { status: 'conflict', sources: legacyEvidence.map((item) => item.path), message: reason };
  }

  await syncDirectory(targetDirectory);
  const sources = legacyEvidence.map((item) => item.path);
  const status = sources.length ? 'imported' : evidence.length ? 'already-current' : 'none';
  await writeMarker(targetDirectory, {
    status,
    sources,
    importedEvidence: [...byName.keys()].filter((relativePath) => legacyEvidence.some((item) => item.relativePath === relativePath)),
    consumedEvidence: legacyEvidence.map(({ path, relativePath, sha256 }) => ({ path, relativePath, sha256 })),
  });
  return { status, sources };
}

async function inspectConsumedBaseline(
  targetDirectory: string,
  legacyDirectories: readonly string[],
  consumed: MigrationMarkerV1,
): Promise<LegacyMigrationResult> {
  const legacyStructureIssues: string[] = [];
  const observedLegacy = (await Promise.all([...new Set(legacyDirectories)].map((directory) => collectFirmwareEvidence(directory, legacyStructureIssues)))).flat();
  const consumedByPath = new Map(consumed.consumedEvidence.map((item) => [item.path, item]));
  const drift = [...legacyStructureIssues, ...observedLegacy.flatMap((item) => {
    const baseline = consumedByPath.get(item.path);
    if (!baseline) return [`New legacy safety evidence appeared after the baseline was consumed: ${item.path}`];
    if (baseline.relativePath !== item.relativePath || baseline.sha256 !== item.sha256) {
      return [`Legacy safety evidence changed after the baseline was consumed: ${item.path}`];
    }
    return [];
  })];
  const issues = await inspectFirmwareSafetyEvidence(targetDirectory);
  if (drift.length || issues.length) {
    const reason = `${[...drift, ...issues.map((issue) => `Previously migrated target evidence is no longer self-consistent: ${issue}`)].join('; ')}. Legacy sources were not reconsidered.`;
    await writeMigrationConflict(targetDirectory, reason, [...await collectFirmwareEvidence(targetDirectory), ...observedLegacy]);
    return { status: 'conflict', sources: consumed.sources, message: reason };
  }
  return { status: consumed.status === 'none' ? 'none' : 'already-current', sources: consumed.sources };
}

function groupByRelativePath(evidence: readonly EvidenceFile[]): Map<string, EvidenceFile[]> {
  const byName = new Map<string, EvidenceFile[]>();
  for (const item of evidence) {
    const group = byName.get(item.relativePath) ?? [];
    group.push(item);
    byName.set(item.relativePath, group);
  }
  return byName;
}

async function writeMarker(
  directory: string,
  value: Omit<MigrationMarkerV1, 'schemaVersion' | 'checkedAt'>,
): Promise<void> {
  const record = migrationMarkerV1Schema.parse({ schemaVersion: 1, checkedAt: new Date().toISOString(), ...value });
  await writeExclusiveAtomic(join(directory, MIGRATION_MARKER_FILENAME), JSON.stringify(record, null, 2));
}

async function readMigrationMarker(path: string): Promise<MigrationMarkerV1 | undefined> {
  let bytes: Uint8Array;
  try {
    bytes = await readStableRegularFile(path, 'legacy migration marker');
  } catch (value) {
    if (isMissing(value)) return undefined;
    throw value;
  }
  return migrationMarkerV1Schema.parse(parseJsonObject(bytes, 'legacy migration marker'));
}

async function writeMigrationConflict(directory: string, reason: string, evidence: readonly EvidenceFile[]): Promise<void> {
  const conflict = migrationConflictV1Schema.parse({
    schemaVersion: 1,
    detectedAt: new Date().toISOString(),
    reason,
    evidence: evidence.map(({ path, relativePath, sha256 }) => ({ path, relativePath, sha256 })),
  });
  await writeExclusiveAtomic(join(directory, MIGRATION_CONFLICT_FILENAME), JSON.stringify(conflict, null, 2));
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (value) { if (isMissing(value)) return false; throw value; }
}

function isMissing(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && 'code' in value && value.code === 'ENOENT');
}
