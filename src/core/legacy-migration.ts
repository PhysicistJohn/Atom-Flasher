import { createHash, randomUUID } from 'node:crypto';
import { type Dirent } from 'node:fs';
import { access, link, lstat, mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { firmwareUpdateJournalSchema } from './contracts.js';

export const JOURNAL_FILENAME = 'firmware-update-journal-v1.json' as const;
export const MIGRATION_MARKER_FILENAME = 'legacy-migration-v1.json' as const;
export const MIGRATION_CONFLICT_FILENAME = 'legacy-migration-conflict-v1.json' as const;
const COMPLETED_LEDGER_DIRECTORY = 'completed-ledger-v1' as const;

export interface LegacyMigrationResult {
  status: 'none' | 'imported' | 'already-current' | 'conflict';
  sources: readonly string[];
  message?: string;
}

export async function migrateLegacyFirmwareState(targetDirectory: string, legacyDirectories: readonly string[]): Promise<LegacyMigrationResult> {
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  const existingConflict = join(targetDirectory, MIGRATION_CONFLICT_FILENAME);
  if (await exists(existingConflict)) {
    return { status: 'conflict', sources: [], message: 'A prior legacy migration conflict remains unresolved' };
  }
  let consumed: MigrationMarkerRecord | undefined;
  try { consumed = await readMigrationMarker(join(targetDirectory, MIGRATION_MARKER_FILENAME)); }
  catch (value) {
    const reason = `The durable legacy migration marker is invalid or unreadable: ${message(value)}. Legacy sources were not reconsidered.`;
    await writeMigrationConflict(targetDirectory, reason, await collectEvidence(targetDirectory));
    return { status: 'conflict', sources: [], message: reason };
  }
  if (consumed) {
    const legacyStructureIssues: string[] = [];
    const observedLegacy = (await Promise.all([...new Set(legacyDirectories)].map((directory) => collectEvidence(directory, legacyStructureIssues)))).flat();
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
      await writeMigrationConflict(targetDirectory, reason, [...await collectEvidence(targetDirectory), ...observedLegacy]);
      return { status: 'conflict', sources: consumed.sources, message: reason };
    }
    return { status: consumed.status === 'none' ? 'none' : 'already-current', sources: consumed.sources };
  }
  const directories = [...new Set([targetDirectory, ...legacyDirectories])];
  const conflicts: string[] = [];
  const evidence = (await Promise.all(directories.map((directory) => collectEvidence(directory, conflicts)))).flat();
  const journals = evidence.filter((item) => item.relativePath === JOURNAL_FILENAME);
  const locks = evidence.filter((item) => item.relativePath === 'firmware-write.lock');
  const journalLocks = evidence.filter((item) => item.relativePath === 'firmware-journal.lock');
  if (new Set(journals.map((candidate) => candidate.sha256)).size > 1) conflicts.push('Active firmware journals have different content');
  if (locks.length > 1) conflicts.push(`Multiple firmware write locks exist (${locks.length})`);
  if (journalLocks.length) conflicts.push(`Durable firmware journal mutex evidence requires manual inspection (${journalLocks.length})`);
  for (const lock of locks) {
    if (lock.directory !== targetDirectory) conflicts.push(`Legacy firmware write lock requires manual inspection in ${lock.directory}`);
    if (!journals.some((journal) => journal.directory === lock.directory)) conflicts.push(`Orphan firmware write lock has no journal in ${lock.directory}`);
  }
  const byName = new Map<string, EvidenceFile[]>();
  for (const item of evidence) {
    const group = byName.get(item.relativePath) ?? [];
    group.push(item);
    byName.set(item.relativePath, group);
  }
  for (const [relativePath, copies] of byName) {
    if (new Set(copies.map((copy) => copy.sha256)).size > 1) conflicts.push(`Safety evidence ${relativePath} has conflicting content`);
  }
  for (const directory of directories) conflicts.push(...await inspectFirmwareSafetyEvidence(directory));

  if (conflicts.length) {
    const reason = `${conflicts.join('; ')}. No safety history was selected and flashing is locked pending manual inspection.`;
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
    conflicts.push(`Safety evidence could not be copied without a collision: ${message(value)}`);
  }
  const targetEvidence = await collectEvidence(targetDirectory, conflicts);
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
    await writeMigrationConflict(targetDirectory, reason, await collectEvidence(targetDirectory));
    return { status: 'conflict', sources: legacyEvidence.map((item) => item.path), message: reason };
  }
  await syncDirectory(targetDirectory);
  const sources = legacyEvidence.map((item) => item.path);
  const status = sources.length ? 'imported' : evidence.length ? 'already-current' : 'none';
  await writeMarker(targetDirectory, {
    status,
    sources,
    importedEvidence: [...byName.keys()].filter((relativePath) => legacyEvidence.some((item) => item.relativePath === relativePath)),
    consumedEvidence: legacyEvidence.map(({ path, relativePath, sha256: hash }) => ({ path, relativePath, sha256: hash })),
  });
  return { status, sources };
}

function isSafetyArtifact(name: string): boolean {
  return name === JOURNAL_FILENAME
    || /^preflight-[a-f0-9-]+\.json$/i.test(name)
    || /^result-[a-f0-9-]+-[a-z-]+\.json$/i.test(name)
    || /^tinySA4_[A-Za-z0-9_.+-]+\.bin$/.test(name)
    || name === 'firmware-write.lock'
    || name === 'firmware-journal.lock';
}

interface EvidenceFile {
  directory: string;
  path: string;
  name: string;
  relativePath: string;
  bytes: Uint8Array;
  sha256: string;
}

interface JournalEvidence {
  preparationId?: string;
  writeDisposition?: string;
  phase?: string;
}

interface MigrationMarkerRecord {
  status: 'none' | 'imported' | 'already-current';
  sources: string[];
  consumedEvidence: Array<{ path: string; relativePath: string; sha256: string }>;
}

export async function inspectFirmwareSafetyEvidence(directory: string): Promise<string[]> {
  const issues: string[] = [];
  const evidence = await collectEvidence(directory, issues);
  const journal = evidence.find((item) => item.relativePath === JOURNAL_FILENAME);
  const locks = evidence.filter((item) => item.relativePath === 'firmware-write.lock');
  const journalLocks = evidence.filter((item) => item.relativePath === 'firmware-journal.lock');
  if (locks.length && !journal) issues.push(`Orphan firmware write lock has no active journal in ${directory}`);
  if (journalLocks.length) issues.push(`Durable firmware journal mutex requires manual inspection in ${directory}`);
  let active: JournalEvidence | undefined;
  if (journal) {
    try { active = parseJournalEvidence(journal.bytes); }
    catch (value) { issues.push(`Active journal cannot support transaction audit checks in ${directory}: ${message(value)}`); }
  }
  const ledgers = collectCompletedLedgerEvidence(directory, evidence, issues);
  for (const item of evidence) {
    if (item.relativePath !== item.name) continue;
    const match = item.name.match(/^result-([a-f0-9-]+)-(write-started|write-complete|verified-complete)\.json$/i);
    if (!match) continue;
    const preparationId = match[1]!;
    const stage = match[2]!.toLowerCase();
    try { parseTransactionAudit(item.bytes, stage, preparationId); }
    catch (value) { issues.push(`Malformed ${stage} audit ${item.path}: ${message(value)}`); continue; }
    const support = [active, ...ledgers].find((record) => record?.preparationId === preparationId);
    if (!support) {
      issues.push(`Orphan ${stage} audit ${item.path} has no matching active journal or completed ledger`);
      continue;
    }
    if (stage === 'write-started' && !['started', 'completed'].includes(support.writeDisposition ?? '')) {
      issues.push(`Write-started audit ${item.path} conflicts with journal disposition ${support.writeDisposition ?? 'missing'}`);
    }
    if (stage === 'write-complete' && support.writeDisposition !== 'completed') {
      issues.push(`Write-complete audit ${item.path} lacks a completed journal disposition`);
    }
    if (stage === 'verified-complete' && (support.writeDisposition !== 'completed' || support.phase !== 'completed')) {
      issues.push(`Verified-complete audit ${item.path} lacks a verified completed journal`);
    }
  }
  return [...new Set(issues)];
}

function collectCompletedLedgerEvidence(directory: string, evidence: readonly EvidenceFile[], issues: string[]): JournalEvidence[] {
  const ledgerPrefix = `${COMPLETED_LEDGER_DIRECTORY}${sep}`;
  const records: JournalEvidence[] = [];
  const byPreparation = new Map<string, EvidenceFile>();
  for (const item of evidence) {
    if (!item.relativePath.startsWith(ledgerPrefix)) continue;
    const path = item.path;
    try {
      const filename = basename(item.relativePath);
      const filenameMatch = filename.match(/^device-(\d+)-preparation-([a-f0-9-]{36})\.json$/i);
      if (!filenameMatch) throw new Error('filename must identify its device and preparation');
      const parsed = firmwareUpdateJournalSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(item.bytes)));
      if (parsed.state.phase !== 'completed' || parsed.state.writeDisposition !== 'completed' || !parsed.state.preparation) throw new Error('ledger is not a verified completed transaction');
      if (parsed.state.preparation.deviceId !== Number(filenameMatch[1]) || parsed.state.preparation.id.toLowerCase() !== filenameMatch[2]!.toLowerCase()) {
        throw new Error('filename does not match the completed transaction identity');
      }
      const previous = byPreparation.get(parsed.state.preparation.id);
      if (previous && previous.sha256 !== item.sha256) throw new Error(`preparation conflicts with completed ledger ${previous.path}`);
      if (previous) throw new Error(`preparation is duplicated by completed ledger ${previous.path}`);
      byPreparation.set(parsed.state.preparation.id, item);
      records.push({ preparationId: parsed.state.preparation.id, phase: parsed.state.phase, writeDisposition: parsed.state.writeDisposition });
    } catch (value) {
      issues.push(`Malformed completed ledger ${path}: ${message(value)}`);
    }
  }
  return records;
}

function parseJournalEvidence(bytes: Uint8Array): JournalEvidence {
  const value = parseJsonObject(bytes, 'journal');
  if (value.schemaVersion !== 1) throw new Error('schemaVersion must be 1');
  const state = asObject(value.state, 'journal state');
  const preparation = state.preparation === undefined ? undefined : asObject(state.preparation, 'journal preparation');
  const preparationId = preparation?.id;
  if (preparationId !== undefined && (typeof preparationId !== 'string' || !/^[a-f0-9-]{36}$/i.test(preparationId))) throw new Error('preparation ID is malformed');
  return {
    ...(typeof preparationId === 'string' ? { preparationId } : {}),
    ...(typeof state.writeDisposition === 'string' ? { writeDisposition: state.writeDisposition } : {}),
    ...(typeof state.phase === 'string' ? { phase: state.phase } : {}),
  };
}

function parseTransactionAudit(bytes: Uint8Array, expectedStage: string, expectedPreparationId: string): void {
  const value = parseJsonObject(bytes, 'transaction audit');
  if (value.schemaVersion !== 1 || value.stage !== expectedStage) throw new Error('schema version or stage does not match its filename');
  const detail = asObject(value.value, 'transaction audit value');
  if (detail.preparationId !== expectedPreparationId) throw new Error('preparation ID does not match its filename');
}

function parseJsonObject(bytes: Uint8Array, label: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (error) { throw new Error(`${label} is not valid UTF-8 JSON`, { cause: error }); }
  return asObject(value, label);
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

async function collectEvidence(directory: string, structuralIssues: string[] = []): Promise<EvidenceFile[]> {
  try {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      structuralIssues.push(`Firmware safety evidence root is not a real directory: ${directory}`);
      return [];
    }
  } catch (value) {
    if (hasCode(value, 'ENOENT')) return [];
    structuralIssues.push(`Firmware safety evidence root cannot be inspected safely at ${directory}: ${message(value)}`);
    return [];
  }
  let entries: Dirent<string>[];
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (value) { if (hasCode(value, 'ENOENT')) return []; throw value; }
  const files: EvidenceFile[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.name === COMPLETED_LEDGER_DIRECTORY) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        structuralIssues.push(`Reserved completed ledger path is not a real directory: ${path}`);
      } else {
        await collectLedgerEvidence(directory, path, entry.name, files, structuralIssues);
      }
      continue;
    }
    if (!isSafetyArtifact(entry.name)) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) {
      structuralIssues.push(`Reserved firmware safety artifact is not a real regular file: ${path}`);
      continue;
    }
    const bytes = await readRegularEvidence(path, structuralIssues);
    if (!bytes) continue;
    files.push({ directory, path, name: entry.name, relativePath: entry.name, bytes, sha256: sha256(bytes) });
  }
  return files;
}

async function collectLedgerEvidence(
  rootDirectory: string,
  currentDirectory: string,
  relativeDirectory: string,
  files: EvidenceFile[],
  structuralIssues: string[],
): Promise<void> {
  const directoryMetadata = await lstat(currentDirectory);
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
    structuralIssues.push(`Completed ledger subtree is not a real directory: ${currentDirectory}`);
    return;
  }
  const entries = await readdir(currentDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(currentDirectory, entry.name);
    const relativePath = join(relativeDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      structuralIssues.push(`Completed ledger contains a symbolic link: ${path}`);
      continue;
    }
    if (entry.isDirectory()) {
      await collectLedgerEvidence(rootDirectory, path, relativePath, files, structuralIssues);
      continue;
    }
    if (!entry.isFile()) {
      structuralIssues.push(`Completed ledger contains a non-regular entry: ${path}`);
      continue;
    }
    if (!entry.name.endsWith('.json')) {
      structuralIssues.push(`Completed ledger contains an unexpected non-JSON file: ${path}`);
      continue;
    }
    const bytes = await readRegularEvidence(path, structuralIssues);
    if (!bytes) continue;
    files.push({ directory: rootDirectory, path, name: entry.name, relativePath, bytes, sha256: sha256(bytes) });
  }
}

async function readRegularEvidence(path: string, structuralIssues: string[]): Promise<Uint8Array | undefined> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      structuralIssues.push(`Firmware safety evidence is not a real regular file: ${path}`);
      return undefined;
    }
    return new Uint8Array(await readFile(path));
  } catch (value) {
    structuralIssues.push(`Firmware safety evidence could not be read safely at ${path}: ${message(value)}`);
    return undefined;
  }
}

async function writeMarker(directory: string, value: object): Promise<void> {
  const path = join(directory, MIGRATION_MARKER_FILENAME);
  const body = JSON.stringify({ schemaVersion: 1, checkedAt: new Date().toISOString(), ...value }, null, 2);
  await writeExclusiveAtomic(path, body);
}

async function readMigrationMarker(path: string): Promise<MigrationMarkerRecord | undefined> {
  let bytes: Uint8Array;
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('marker is not a real regular file');
    bytes = new Uint8Array(await readFile(path));
  }
  catch (value) { if (hasCode(value, 'ENOENT')) return undefined; throw value; }
  const value = parseJsonObject(bytes, 'legacy migration marker');
  if (value.schemaVersion !== 1) throw new Error('marker schemaVersion must be 1');
  if (value.status !== 'none' && value.status !== 'imported' && value.status !== 'already-current') throw new Error('marker status is invalid');
  if (typeof value.checkedAt !== 'string' || !Number.isFinite(Date.parse(value.checkedAt))) throw new Error('marker checkedAt is invalid');
  if (!Array.isArray(value.sources) || !value.sources.every((source) => typeof source === 'string')) throw new Error('marker sources must be strings');
  if (!Array.isArray(value.importedEvidence) || !value.importedEvidence.every((item) => typeof item === 'string')) throw new Error('marker importedEvidence must be strings');
  if (!Array.isArray(value.consumedEvidence)) throw new Error('marker consumedEvidence must be an array');
  const consumedEvidence = value.consumedEvidence.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('marker consumedEvidence item must be an object');
    const record = item as Record<string, unknown>;
    if (typeof record.path !== 'string' || typeof record.relativePath !== 'string'
      || typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256)) {
      throw new Error('marker consumedEvidence item is malformed');
    }
    return { path: record.path, relativePath: record.relativePath, sha256: record.sha256 };
  });
  return { status: value.status, sources: [...value.sources], consumedEvidence };
}

async function writeMigrationConflict(directory: string, reason: string, evidence: readonly EvidenceFile[]): Promise<void> {
  const conflict = {
    schemaVersion: 1,
    detectedAt: new Date().toISOString(),
    reason,
    evidence: evidence.map(({ path, relativePath, sha256: hash }) => ({ path, relativePath, sha256: hash })),
  };
  await writeExclusiveAtomic(join(directory, MIGRATION_CONFLICT_FILENAME), JSON.stringify(conflict, null, 2));
}

async function copyEvidenceAtomic(source: EvidenceFile, destination: string, targetRoot: string): Promise<void> {
  const destinationDirectory = dirname(destination);
  await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
  const existingHash = await regularFileSha256(destination);
  if (existingHash !== undefined) {
    if (existingHash !== source.sha256) throw new Error(`${source.relativePath} already exists with SHA-256 ${existingHash}, expected ${source.sha256}`);
    for (const directory of directoryChainToRoot(destinationDirectory, targetRoot)) await syncDirectory(directory);
    return;
  }

  const temporary = join(destinationDirectory, `.${basename(destination)}.${randomUUID()}.part`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(source.bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const stagedHash = await regularFileSha256(temporary);
    if (stagedHash !== source.sha256) throw new Error(`${source.relativePath} staged with SHA-256 ${stagedHash ?? 'missing'}, expected ${source.sha256}`);
    try {
      // A hard-link install gives the destination an all-or-nothing, no-replace
      // transition while keeping the staged bytes on the same filesystem.
      await link(temporary, destination);
    } catch (value) {
      if (!hasCode(value, 'EEXIST')) throw value;
      const collisionHash = await regularFileSha256(destination);
      if (collisionHash !== source.sha256) throw new Error(`${source.relativePath} collided with SHA-256 ${collisionHash ?? 'non-regular'}, expected ${source.sha256}`);
    }
  } finally {
    await rm(temporary, { force: true });
  }
  const installedHash = await regularFileSha256(destination);
  if (installedHash !== source.sha256) throw new Error(`${source.relativePath} installed with SHA-256 ${installedHash ?? 'missing'}, expected ${source.sha256}`);
  for (const directory of directoryChainToRoot(destinationDirectory, targetRoot)) await syncDirectory(directory);
}

export function directoryChainToRoot(leafDirectory: string, rootDirectory: string): string[] {
  const leaf = resolve(leafDirectory);
  const root = resolve(rootDirectory);
  const fromRoot = relative(root, leaf);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new Error(`${leaf} is outside migration target ${root}`);
  const chain: string[] = [];
  let current = leaf;
  while (true) {
    chain.push(current);
    if (current === root) return chain;
    const parent = dirname(current);
    if (parent === current) throw new Error(`Could not reach migration target ${root} from ${leaf}`);
    current = parent;
  }
}

async function regularFileSha256(path: string): Promise<string | undefined> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${path} is not a regular file`);
    return sha256(new Uint8Array(await readFile(path)));
  } catch (value) {
    if (hasCode(value, 'ENOENT')) return undefined;
    throw value;
  }
}

async function writeExclusiveAtomic(path: string, body: string): Promise<void> {
  if (await regularFileSha256(path) !== undefined) return;
  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.part`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(body, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    try { await link(temporary, path); }
    catch (value) {
      if (!hasCode(value, 'EEXIST')) throw value;
      if (await regularFileSha256(path) === undefined) throw new Error(`${path} collided with a non-regular file`);
    }
  } finally {
    await rm(temporary, { force: true });
  }
  await syncDirectory(directory);
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return (await stat(path)).isFile(); } catch { return false; }
}

function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function hasCode(value: unknown, code: string): boolean { return Boolean(value && typeof value === 'object' && 'code' in value && value.code === code); }
function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }
