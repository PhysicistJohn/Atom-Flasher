import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, type Dirent, type Stats } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readdir, rm, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  ACTIVE_JOURNAL_FILENAMES,
  COMPLETED_LEDGER_DIRECTORIES,
  MIGRATION_CONFLICT_FILENAME,
  MIGRATION_MARKER_FILENAME,
  RESERVED_COMPLETED_LEDGER_DIRECTORY_REGEXP,
  RESERVED_JOURNAL_FILENAME_REGEXP,
  RESERVED_MIGRATION_FILENAME_REGEXP,
  isFirmwareSafetyArtifact,
} from './evidence-layout.js';

export const MAX_DURABLE_FILE_BYTES = 8 * 1024 * 1024;

export type StableRegularFileOptions = Readonly<{
  afterInitialLstat?(): Promise<void>;
  afterOpenedStat?(): Promise<void>;
  allowMultipleLinks?: boolean;
}>;

export interface EvidenceFile {
  directory: string;
  path: string;
  name: string;
  relativePath: string;
  bytes: Uint8Array;
  sha256: string;
}

/** Creates or proves the owner-only root that contains firmware safety state. */
export async function ensurePrivateFirmwareDirectory(path: string): Promise<void> {
  const created = await mkdir(path, { recursive: true, mode: 0o700 });
  let before = await lstat(path);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error(`Firmware state root is not a real directory: ${path}`);
  }
  if (typeof process.getuid === 'function' && before.uid !== process.getuid()) {
    throw new Error(`Firmware state root is not owned by the current user: ${path}`);
  }
  if (process.platform !== 'win32') {
    if ((before.mode & 0o022) !== 0) {
      throw new Error(`Firmware state root is writable by another user or group: ${path}`);
    }
    if ((before.mode & 0o777) !== 0o700) {
      // A prior version may have created an owner-controlled 0755 directory.
      // Tightening that directory is safe because no other identity could
      // mutate its entries; a directory with write bits above is never blessed.
      await chmod(path, 0o700);
      before = await lstat(path);
    }
    if ((before.mode & 0o777) !== 0o700) {
      throw new Error(`Firmware state root is not owner-only (mode 0700): ${path}`);
    }
  }
  if (created !== undefined || process.platform !== 'win32') await syncDirectory(dirname(path));
  const after = await lstat(path);
  if (!after.isDirectory() || after.isSymbolicLink() || !sameInode(before, after)
    || after.uid !== before.uid || after.mode !== before.mode) {
    throw new Error(`Firmware state root changed while it was validated: ${path}`);
  }
}

/** Collects reserved evidence without following links or accepting special files. */
export async function collectFirmwareEvidence(directory: string, structuralIssues: string[] = []): Promise<EvidenceFile[]> {
  try {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      structuralIssues.push(`Firmware safety evidence root is not a real directory: ${directory}`);
      return [];
    }
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
      structuralIssues.push(`Firmware safety evidence root is not owned by the current user: ${directory}`);
      return [];
    }
    if (process.platform !== 'win32' && (metadata.mode & 0o022) !== 0) {
      structuralIssues.push(`Firmware safety evidence root is writable by another user or group: ${directory}`);
      return [];
    }
  } catch (value) {
    if (hasCode(value, 'ENOENT')) return [];
    structuralIssues.push(`Firmware safety evidence root cannot be inspected safely at ${directory}: ${errorMessage(value)}`);
    return [];
  }

  let entries: Dirent<string>[];
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (value) { if (hasCode(value, 'ENOENT')) return []; throw value; }
  const files: EvidenceFile[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (RESERVED_COMPLETED_LEDGER_DIRECTORY_REGEXP.test(entry.name)) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        structuralIssues.push(`Reserved completed ledger path is not a real directory: ${path}`);
      } else if (!COMPLETED_LEDGER_DIRECTORIES.includes(entry.name as typeof COMPLETED_LEDGER_DIRECTORIES[number])) {
        structuralIssues.push(`Unsupported completed ledger version requires manual inspection: ${path}`);
      } else {
        await collectLedgerEvidence(directory, path, entry.name, files, structuralIssues);
      }
      continue;
    }
    if (!isFirmwareSafetyArtifact(entry.name)) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) {
      structuralIssues.push(`Reserved firmware safety artifact is not a real regular file: ${path}`);
      continue;
    }
    if (RESERVED_JOURNAL_FILENAME_REGEXP.test(entry.name)
      && !ACTIVE_JOURNAL_FILENAMES.includes(entry.name as typeof ACTIVE_JOURNAL_FILENAMES[number])) {
      structuralIssues.push(`Unsupported active journal version requires manual inspection: ${path}`);
      continue;
    }
    if (RESERVED_MIGRATION_FILENAME_REGEXP.test(entry.name)) {
      if (entry.name === MIGRATION_CONFLICT_FILENAME) {
        structuralIssues.push(`Legacy migration conflict requires manual inspection: ${path}`);
      } else if (entry.name !== MIGRATION_MARKER_FILENAME) {
        structuralIssues.push(`Unsupported legacy-migration evidence version requires manual inspection: ${path}`);
      }
      // A normal migration marker describes this directory's discovery
      // history and is not transferable transaction evidence. Conflicts and
      // unknown versions are reported above, then likewise never copied.
      continue;
    }
    const bytes = await readRegularEvidence(path, structuralIssues);
    if (!bytes) continue;
    files.push({ directory, path, name: entry.name, relativePath: entry.name, bytes, sha256: sha256Bytes(bytes) });
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
  let entries: Dirent<string>[];
  try {
    const metadata = await lstat(currentDirectory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      structuralIssues.push(`Completed ledger subtree is not a real directory: ${currentDirectory}`);
      return;
    }
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
      structuralIssues.push(`Completed ledger subtree is not owned by the current user: ${currentDirectory}`);
      return;
    }
    if (process.platform !== 'win32' && (metadata.mode & 0o022) !== 0) {
      structuralIssues.push(`Completed ledger subtree is writable by another user or group: ${currentDirectory}`);
      return;
    }
    entries = await readdir(currentDirectory, { withFileTypes: true });
  } catch (value) {
    structuralIssues.push(`Completed ledger subtree cannot be read safely at ${currentDirectory}: ${errorMessage(value)}`);
    return;
  }
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
    files.push({ directory: rootDirectory, path, name: entry.name, relativePath, bytes, sha256: sha256Bytes(bytes) });
  }
}

async function readRegularEvidence(path: string, structuralIssues: string[]): Promise<Uint8Array | undefined> {
  try {
    return await readStableRegularFile(path, 'firmware safety evidence');
  } catch (value) {
    structuralIssues.push(`Firmware safety evidence could not be read safely at ${path}: ${errorMessage(value)}`);
    return undefined;
  }
}

export async function copyEvidenceAtomic(source: EvidenceFile, destination: string, targetRoot: string): Promise<void> {
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
  let installed = false;
  try {
    const stagedHash = await regularFileSha256(temporary);
    if (stagedHash !== source.sha256) throw new Error(`${source.relativePath} staged with SHA-256 ${stagedHash ?? 'missing'}, expected ${source.sha256}`);
    try {
      // A hard-link install is atomic and refuses replacement on the same filesystem.
      await link(temporary, destination);
      installed = true;
    } catch (value) {
      if (!hasCode(value, 'EEXIST')) throw value;
      const collisionHash = await regularFileSha256(destination);
      if (collisionHash !== source.sha256) {
        throw new Error(`${source.relativePath} collided with SHA-256 ${collisionHash ?? 'non-regular'}, expected ${source.sha256}`, { cause: value });
      }
    }
    // Persist a newly installed final name while the synced staging inode is
    // still reachable. A crash before this point may leave either/both links,
    // but can never leave the only surviving name dependent on an unsynced link.
    if (installed) await syncDirectory(destinationDirectory);
  } catch (value) {
    // Retain the staged sibling when final-name durability is uncertain.
    if (!installed) await rm(temporary, { force: true });
    throw value;
  }
  await rm(temporary, { force: true });
  await syncDirectory(destinationDirectory);
  const installedHash = await regularFileSha256(destination);
  if (installedHash !== source.sha256) throw new Error(`${source.relativePath} installed with SHA-256 ${installedHash ?? 'missing'}, expected ${source.sha256}`);
  for (const directory of directoryChainToRoot(destinationDirectory, targetRoot)) await syncDirectory(directory);
}

/** Writes a durable file once. Existing evidence is never replaced. */
export async function writeExclusiveAtomic(path: string, body: string): Promise<void> {
  const expectedHash = sha256Bytes(new TextEncoder().encode(body));
  const existingHash = await regularFileSha256(path);
  if (existingHash !== undefined) {
    if (existingHash !== expectedHash) {
      throw new Error(`Durable evidence collision at ${path}: existing SHA-256 ${existingHash}, expected ${expectedHash}`);
    }
    // A prior create-once attempt may have installed the final hard link and
    // then failed while syncing its parent. Re-establish directory durability
    // before accepting matching bytes on retry.
    await syncDirectory(dirname(path));
    return;
  }
  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.part`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(body, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  let installed = false;
  try {
    try {
      await link(temporary, path);
      installed = true;
    }
    catch (value) {
      if (!hasCode(value, 'EEXIST')) throw value;
      const collisionHash = await regularFileSha256(path);
      if (collisionHash === undefined) throw new Error(`${path} collided with a non-regular file`, { cause: value });
      if (collisionHash !== expectedHash) {
        throw new Error(`Durable evidence collision at ${path}: existing SHA-256 ${collisionHash}, expected ${expectedHash}`, { cause: value });
      }
    }
    if (installed) await syncDirectory(directory);
  } catch (value) {
    if (!installed) await rm(temporary, { force: true });
    throw value;
  }
  await rm(temporary, { force: true });
  await syncDirectory(directory);
  const installedHash = await regularFileSha256(path);
  if (installedHash !== expectedHash) {
    throw new Error(`Durable evidence at ${path} has SHA-256 ${installedHash ?? 'missing'}, expected ${expectedHash}`);
  }
  await syncDirectory(directory);
}

/**
 * Durably installs new immutable evidence and rejects every collision. Unlike
 * idempotent migration writes, a transaction record must never accept an
 * existing path merely because its filename happens to match.
 */
export async function writeNewDurableFile(path: string, body: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.part`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(body, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  let installed = false;
  try {
    try {
      await link(temporary, path);
      installed = true;
    }
    catch (value) {
      if (hasCode(value, 'EEXIST')) throw new Error(`Immutable evidence already exists at ${path}`, { cause: value });
      throw value;
    }
    await syncDirectory(directory);
  } catch (value) {
    if (!installed) await rm(temporary, { force: true });
    throw value;
  }
  await rm(temporary, { force: true });
  await syncDirectory(directory);
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

export async function regularFileSha256(path: string): Promise<string | undefined> {
  try {
    return sha256Bytes(await readStableRegularFile(path, 'durable file'));
  } catch (value) {
    if (hasCode(value, 'ENOENT')) return undefined;
    throw value;
  }
}

/**
 * Reads one pathname without ever following a final-component symlink, and
 * proves that the directory entry, opened description, and bytes all describe
 * the same stable regular inode. This is shared by evidence inspection and by
 * create-once collision decisions.
 */
export async function readStableRegularFile(
  path: string,
  label: string,
  options: StableRegularFileOptions = {},
): Promise<Uint8Array> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} is not a regular file: ${path}`);
  await options.afterInitialLstat?.();
  let handle;
  try {
    const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | noFollow);
    const opened = await handle.stat();
    if (!opened.isFile() || !sameInode(before, opened)) throw new Error(`${label} changed while it was opened: ${path}`);
    if (typeof process.getuid === 'function' && opened.uid !== process.getuid()) {
      throw new Error(`${label} is not owned by the current user: ${path}`);
    }
    if (process.platform !== 'win32' && (opened.mode & 0o022) !== 0) {
      throw new Error(`${label} is writable by another user or group: ${path}`);
    }
    if (!options.allowMultipleLinks && opened.nlink !== 1) {
      throw new Error(`${label} must have exactly one filesystem link: ${path}`);
    }
    if (!Number.isSafeInteger(opened.size) || opened.size < 0 || opened.size > MAX_DURABLE_FILE_BYTES) {
      throw new Error(`${label} exceeds the ${MAX_DURABLE_FILE_BYTES}-byte safety bound: ${path}`);
    }
    await options.afterOpenedStat?.();
    const bytes = await positionedReadExactly(handle, opened.size, label);
    const afterDescriptor = await handle.stat();
    const afterPath = await lstat(path);
    if (!afterPath.isFile()
      || afterPath.isSymbolicLink()
      || !sameInode(opened, afterDescriptor)
      || !sameInode(opened, afterPath)
      || !sameSnapshot(opened, afterDescriptor)
      || !sameSnapshot(opened, afterPath)
      || bytes.byteLength !== opened.size) {
      throw new Error(`${label} changed while it was read: ${path}`);
    }
    return bytes;
  } finally {
    await handle?.close();
  }
}

async function positionedReadExactly(handle: FileHandle, size: number, label: string): Promise<Uint8Array> {
  const bytes = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
    if (bytesRead <= 0) throw new Error(`${label} became shorter while it was being read`);
    offset += bytesRead;
  }
  const probe = new Uint8Array(1);
  if ((await handle.read(probe, 0, 1, size)).bytesRead !== 0) {
    throw new Error(`${label} became longer while it was being read`);
  }
  return bytes;
}

function sameInode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: Stats, right: Stats): boolean {
  return sameInode(left, right)
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid
    && left.gid === right.gid
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export function parseJsonObject(bytes: Uint8Array, label: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (error) { throw new Error(`${label} is not valid UTF-8 JSON`, { cause: error }); }
  return asObject(value, label);
}

export function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function hasCode(value: unknown, code: string): boolean {
  return Boolean(value && typeof value === 'object' && 'code' in value && value.code === code);
}

export function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
