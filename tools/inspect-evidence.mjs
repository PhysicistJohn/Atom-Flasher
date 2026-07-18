#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { firmwareUpdateJournalV1Schema } from '../src/core/persistence/evidence-schemas-v1.ts';
import { firmwareUpdateJournalV2Schema } from '../src/core/persistence/evidence-schemas-v2.ts';

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 10_000;
const JSON_EVIDENCE = /(?:^|\/)(?:firmware-update-journal-v\d+|legacy-migration(?:-conflict)?-v\d+|preflight-[^/]+|result-[^/]+|completed-ledger-v\d+\/.+)\.json$/;
const LOCK_EVIDENCE = /(?:^|\/)firmware-(?:write|journal)\.lock$/;
const JOURNAL_SCHEMAS = Object.freeze({
  1: firmwareUpdateJournalV1Schema,
  2: firmwareUpdateJournalV2Schema,
});

export async function inspectEvidence(rootPath) {
  const root = resolve(rootPath);
  const report = {
    schemaVersion: 1,
    inspectedPath: root,
    inspectedAt: new Date().toISOString(),
    exists: false,
    counts: {
      files: 0,
      activeJournals: 0,
      completedLedgers: 0,
      locks: 0,
      preflights: 0,
      results: 0,
      migrationRecords: 0,
    },
    hazards: [],
    warnings: [],
    evidence: [],
  };

  const pathSnapshot = await snapshotPath(root);
  if (pathSnapshot.symbolicLink) {
    report.exists = true;
    report.hazards.push(`Evidence path contains a symbolic-link component; inspection refused: ${pathSnapshot.symbolicLink}`);
    return report;
  }
  if (!pathSnapshot.exists) return report;
  const rootStatus = pathSnapshot.entries.at(-1)?.status;
  if (!rootStatus) throw new Error(`Could not establish evidence root identity: ${root}`);
  report.exists = true;
  if (!rootStatus.isDirectory()) {
    report.hazards.push('Evidence root exists but is not a directory');
    return report;
  }

  await visitDirectory(root, '', report, rootStatus);
  await assertPathSnapshotStable(pathSnapshot.entries);
  report.evidence.sort((left, right) => left.path.localeCompare(right.path));
  deriveHazards(report);
  return report;
}

async function visitDirectory(root, relativeDirectory, report, expectedStatus) {
  const directory = join(root, relativeDirectory);
  const before = await lstat(directory, { bigint: true });
  if (expectedStatus && !sameStableEntry(expectedStatus, before)) {
    throw new Error(`Evidence root changed before inspection began: ${directory}`);
  }
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error(`Evidence directory changed to a link or non-directory during inspection: ${relativeDirectory || '.'}`);
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const afterListing = await lstat(directory, { bigint: true });
  if (!sameStableEntry(before, afterListing)) {
    throw new Error(`Evidence directory changed while it was listed: ${relativeDirectory || '.'}`);
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relativePath = join(relativeDirectory, entry.name);
    if (report.counts.files >= MAX_FILES) throw new Error(`Evidence tree exceeds the ${MAX_FILES}-file inspection bound`);
    if (entry.isSymbolicLink()) {
      report.warnings.push(`Skipped symbolic link: ${relativePath}`);
      continue;
    }
    if (entry.isDirectory()) {
      await visitDirectory(root, relativePath, report);
      continue;
    }
    if (!entry.isFile()) {
      report.warnings.push(`Skipped non-regular entry: ${relativePath}`);
      continue;
    }
    report.counts.files += 1;
    report.evidence.push(await inspectFile(root, relativePath, report));
  }
  const afterTraversal = await lstat(directory, { bigint: true });
  if (!sameStableEntry(before, afterTraversal)) {
    throw new Error(`Evidence directory changed while it was traversed: ${relativeDirectory || '.'}`);
  }
}

async function inspectFile(root, relativePath, report) {
  const absolutePath = join(root, relativePath);
  assertWithinRoot(root, absolutePath);
  const normalized = relativePath.split(sep).join('/');
  const kind = classify(normalized);
  increment(kind, report.counts);
  const pathBefore = await lstat(absolutePath, { bigint: true });
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) {
    throw new Error(`Evidence changed to a link or non-regular file during inspection: ${normalized}`);
  }
  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const status = await handle.stat({ bigint: true });
    if (!status.isFile() || !sameStableEntry(pathBefore, status)) {
      throw new Error(`Evidence changed while it was opened: ${normalized}`);
    }
    const byteLength = Number(status.size);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new Error(`Evidence size is unsafe to inspect: ${normalized}`);
    const isJsonEvidence = JSON_EVIDENCE.test(normalized);
    let jsonBytes;
    if (isJsonEvidence && byteLength <= MAX_JSON_BYTES) jsonBytes = await handle.readFile();
    const item = {
      path: normalized,
      kind,
      bytes: byteLength,
      modifiedAt: new Date(Number(status.mtimeMs)).toISOString(),
      sha256: jsonBytes ? createHash('sha256').update(jsonBytes).digest('hex') : await hashHandle(handle),
    };

    const afterDescriptor = await handle.stat({ bigint: true });
    const pathAfter = await lstat(absolutePath, { bigint: true });
    if (!sameStableEntry(status, afterDescriptor) || !sameStableEntry(status, pathAfter)) {
      throw new Error(`Evidence changed while it was hashed: ${normalized}`);
    }

    if (!isJsonEvidence) return item;
    if (!jsonBytes) {
      report.warnings.push(`Skipped JSON decoding above ${MAX_JSON_BYTES} bytes: ${normalized}`);
      return item;
    }
    try {
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(jsonBytes));
      item.json = summarizeJson(value);
      if (kind === 'active-journal') item.jsonStructureError = validateActiveJournal(value, normalized);
    } catch (error) {
      item.jsonError = error instanceof Error ? error.message : String(error);
      report.hazards.push(`Malformed JSON evidence: ${normalized}`);
    }
    return item;
  } finally {
    await handle.close();
  }
}

function sameStableEntry(left, right) {
  return !right.isSymbolicLink()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid
    && left.gid === right.gid
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function classify(path) {
  const name = basename(path);
  if (/^firmware-update-journal-v\d+\.json$/.test(name)) return 'active-journal';
  if (path.startsWith('completed-ledger-v') && name.endsWith('.json')) return 'completed-ledger';
  if (LOCK_EVIDENCE.test(path)) return name === 'firmware-write.lock' ? 'write-lock' : 'journal-lock';
  if (/^preflight-[^/]+\.json$/.test(name)) return 'preflight';
  if (/^result-[^/]+\.json$/.test(name)) return 'result';
  if (/^legacy-migration(?:-conflict)?-v\d+\.json$/.test(name)) return 'migration-record';
  if (/\.(?:bin|part)$/.test(name)) return 'firmware-artifact';
  return 'other';
}

function increment(kind, counts) {
  if (kind === 'active-journal') counts.activeJournals += 1;
  else if (kind === 'completed-ledger') counts.completedLedgers += 1;
  else if (kind === 'write-lock' || kind === 'journal-lock') counts.locks += 1;
  else if (kind === 'preflight') counts.preflights += 1;
  else if (kind === 'result') counts.results += 1;
  else if (kind === 'migration-record') counts.migrationRecords += 1;
}

function summarizeJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { rootType: Array.isArray(value) ? 'array' : typeof value };
  const state = value.state && typeof value.state === 'object' && !Array.isArray(value.state) ? value.state : undefined;
  const summary = {};
  copyScalar(value, summary, 'schemaVersion');
  copyScalar(value, summary, 'targetVersion');
  copyScalar(value, summary, 'writtenAt');
  copyScalar(value, summary, 'completedAt');
  copyScalar(value, summary, 'status');
  copyScalar(state, summary, 'phase');
  copyScalar(state, summary, 'writeDisposition');
  copyScalar(state, summary, 'writeStartedAt');
  copyScalar(state, summary, 'writeCompletedAt');
  return Object.keys(summary).length ? summary : { rootType: 'object' };
}

function validateActiveJournal(value, path) {
  const fileVersion = Number(/^firmware-update-journal-v(\d+)\.json$/.exec(basename(path))?.[1]);
  const schema = JOURNAL_SCHEMAS[fileVersion];
  if (!schema) return `unsupported journal filename version ${String(fileVersion)}`;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return parsed.error.issues.slice(0, 3).map((issue) => {
      const location = issue.path.length ? `${issue.path.join('.')}: ` : '';
      return `${location}${issue.message}`;
    }).join('; ');
  }
  return undefined;
}

function copyScalar(source, target, key) {
  const value = source?.[key];
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') target[key] = value;
}

function deriveHazards(report) {
  const active = report.evidence.filter((item) => item.kind === 'active-journal');
  const writeLocks = report.evidence.filter((item) => item.kind === 'write-lock');
  const journalLocks = report.evidence.filter((item) => item.kind === 'journal-lock');
  if (active.length > 1) report.hazards.push('Multiple active firmware journals are present');
  if (writeLocks.length) report.hazards.push('A firmware write-owner lock is present; do not retry a flash without investigating it');
  if (journalLocks.length) report.hazards.push('A firmware journal mutex is present; another process or interrupted mutation may own it');
  for (const item of active) {
    const disposition = item.json?.writeDisposition;
    if (item.jsonStructureError) {
      report.hazards.push(`Active journal is structurally invalid (${item.jsonStructureError}): ${item.path}`);
    } else if (!item.json) {
      report.hazards.push(`Active journal could not be safely decoded and classified: ${item.path}`);
    } else if (disposition !== 'not-started') {
      report.hazards.push(`Active journal reports write disposition ${disposition}: ${item.path}`);
    }
  }
  const conflicts = report.evidence.filter((item) => /legacy-migration-conflict/.test(item.path));
  if (conflicts.length) report.hazards.push('A legacy migration conflict record is present');
}

async function hashHandle(handle) {
  const digest = createHash('sha256');
  const stream = handle.createReadStream({ autoClose: false, start: 0 });
  for await (const chunk of stream) digest.update(chunk);
  return digest.digest('hex');
}

async function snapshotPath(path) {
  const pathRoot = parse(path).root;
  const components = relative(pathRoot, path).split(sep).filter(Boolean);
  const entries = [];
  let current = pathRoot;
  for (const component of components) {
    current = join(current, component);
    let status;
    try {
      status = await lstat(current, { bigint: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return { entries, exists: false };
      throw error;
    }
    entries.push({ path: current, status });
    if (status.isSymbolicLink()) return { entries, exists: true, symbolicLink: current };
  }
  if (components.length === 0) {
    const status = await lstat(pathRoot, { bigint: true });
    entries.push({ path: pathRoot, status });
  }
  return { entries, exists: true };
}

async function assertPathSnapshotStable(entries) {
  for (const entry of entries) {
    const current = await lstat(entry.path, { bigint: true });
    if (current.isSymbolicLink()
      || current.dev !== entry.status.dev
      || current.ino !== entry.status.ino
      || current.mode !== entry.status.mode) {
      throw new Error(`Evidence path component changed during inspection: ${entry.path}`);
    }
  }
}

function assertWithinRoot(root, path) {
  const local = relative(root, path);
  if (local === '..' || local.startsWith(`..${sep}`) || local.startsWith(sep)) {
    throw new Error(`Refusing to inspect outside evidence root: ${path}`);
  }
}

function parseArguments(argv) {
  let path;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') json = true;
    else if (argument === '--path') {
      path = argv[index + 1];
      if (!path) throw new Error('--path requires a directory');
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      return { help: true, json, path };
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return { help: false, json, path };
}

function defaultEvidencePath() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Flasher', 'firmware');
  if (process.platform === 'win32') return join(process.env.APPDATA ?? homedir(), 'Flasher', 'firmware');
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Flasher', 'firmware');
}

function printHuman(report) {
  process.stdout.write(`Evidence directory: ${report.inspectedPath}\n`);
  if (!report.exists) {
    process.stdout.write('Status: directory does not exist (no evidence inspected)\n');
    return;
  }
  process.stdout.write(`Files: ${report.counts.files}; active journals: ${report.counts.activeJournals}; completed ledgers: ${report.counts.completedLedgers}; locks: ${report.counts.locks}\n`);
  for (const item of report.evidence) {
    const state = item.json?.phase ? `; phase=${item.json.phase}; write=${item.json.writeDisposition ?? 'unknown'}` : '';
    process.stdout.write(`- [${item.kind}] ${item.path} (${item.bytes} bytes, sha256 ${item.sha256})${state}\n`);
    if (item.jsonError) process.stdout.write(`  JSON ERROR: ${item.jsonError}\n`);
  }
  for (const warning of report.warnings) process.stdout.write(`WARNING: ${warning}\n`);
  if (report.hazards.length) {
    process.stdout.write('HAZARDS — preserve evidence and do not retry a write until investigated:\n');
    for (const hazard of report.hazards) process.stdout.write(`- ${hazard}\n`);
  } else {
    process.stdout.write('No obvious evidence hazard was detected. This is an inventory, not authorization to flash or delete evidence.\n');
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: npm run inspect:evidence -- [--path /absolute/firmware] [--json]\n');
    process.stdout.write('Reads, hashes, and summarizes evidence without modifying evidence or following symbolic-link path components.\n');
    return;
  }
  const report = await inspectEvidence(options.path ?? defaultEvidencePath());
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printHuman(report);
  if (report.hazards.length) process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
