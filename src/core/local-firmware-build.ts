import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import { chmod, link, lstat, mkdir, open, rm, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  localCustomFirmwareTargetSchema,
  type LocalCustomFirmwareTarget,
} from './contracts.js';
import {
  openVerifiedFirmwareFile,
  type VerifiedFirmwareArtifact,
} from './firmware-artifact.js';
import { ensurePrivateFirmwareDirectory, syncDirectory } from './persistence/durable-files.js';

export const MANIFEST_SCHEMA_ID = 'https://physicistjohn.github.io/tinysa-flasher/contracts/schemas/tinysa-firmware-build-manifest-v1.schema.json';
const MAXIMUM_MANIFEST_BYTES = 64 * 1024;
const MINIMUM_FIRMWARE_BYTES = 8 * 1024;
export const ZS407_MAXIMUM_WRITE_BYTES = 240 * 1024;
const ZS407_LOAD_ADDRESS = 0x0800_0000;

const lowercaseHex32Schema = z.string().regex(/^0x[0-9a-f]{8}$/);
export const localFirmwareBuildManifestSchema = z.object({
  $schema: z.literal(MANIFEST_SCHEMA_ID),
  manifestVersion: z.literal(1),
  artifact: z.object({
    filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.bin$/).max(160),
    format: z.literal('raw-stm32-binary'),
    sizeBytes: z.number().int().min(MINIMUM_FIRMWARE_BYTES).max(ZS407_MAXIMUM_WRITE_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    loadAddress: z.literal('0x08000000'),
    maximumWriteBytes: z.literal(ZS407_MAXIMUM_WRITE_BYTES),
    initialStackPointer: lowercaseHex32Schema,
    resetHandler: lowercaseHex32Schema,
  }).strict(),
  firmware: z.object({
    product: z.literal('tinySA Ultra / Ultra+'),
    hardwareTarget: z.literal('ZS407'),
    mcu: z.literal('STM32F303'),
    version: z.string().regex(/^tinySA4_[A-Za-z0-9.+_-]{1,96}-g[a-f0-9]{7,40}$/).max(128),
    reportedRevision: z.string().regex(/^[a-f0-9]{7,40}$/),
    sourceRepository: z.literal('PhysicistJohn/TinySA_Firmware'),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    sourceTree: z.literal('tracked-clean'),
    chibiosCommit: z.string().regex(/^[a-f0-9]{40}$/),
  }).strict(),
  build: z.object({
    sourceDateEpoch: z.number().int().positive(),
    toolchain: z.string().min(1).max(200),
    reproducibleCleanBuilds: z.literal(true),
    hardwareQualification: z.enum(['unqualified', 'qualified-on-zs407']),
    simulationQualification: z.enum(['not-run', 'passed']),
    qualificationEvidenceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }).strict(),
  flashPolicy: z.object({
    physicalFlash: z.literal('operator-confirmed-only'),
    automatedFlash: z.literal(false),
    requiresKnownGoodRollback: z.literal(true),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const issue = (path: (string | number)[], message: string) => context.addIssue({ code: 'custom', path, message });
  const versionRevision = manifest.firmware.version.match(/-g([a-f0-9]{7,40})$/)?.[1];
  if (versionRevision !== manifest.firmware.reportedRevision) {
    issue(['firmware', 'reportedRevision'], 'Reported revision must exactly match the version suffix');
  }
  if (!manifest.firmware.sourceCommit.startsWith(manifest.firmware.reportedRevision)) {
    issue(['firmware', 'sourceCommit'], 'Source commit must begin with the firmware-reported revision');
  }
  if (manifest.build.hardwareQualification === 'qualified-on-zs407'
    && manifest.build.qualificationEvidenceSha256 === undefined) {
    issue(['build', 'qualificationEvidenceSha256'], 'Hardware-qualified builds require immutable qualification evidence');
  }
  if (manifest.build.hardwareQualification === 'unqualified'
    && manifest.build.qualificationEvidenceSha256 !== undefined) {
    issue(['build', 'qualificationEvidenceSha256'], 'Unqualified builds cannot claim hardware qualification evidence');
  }
});
export type LocalFirmwareBuildManifest = z.infer<typeof localFirmwareBuildManifestSchema>;

export interface ImportedLocalFirmwareBuild {
  readonly manifest: LocalFirmwareBuildManifest;
  readonly manifestSha256: string;
  readonly artifactPath: string;
  readonly manifestPath: string;
  readonly importedAt: string;
}

export function localCustomTargetForBuild(imported: ImportedLocalFirmwareBuild): LocalCustomFirmwareTarget {
  const manifest = localFirmwareBuildManifestSchema.parse(imported.manifest);
  return localCustomFirmwareTargetSchema.parse({
    kind: 'local-custom',
    targetId: `custom-zs407-${manifest.artifact.sha256}`,
    product: manifest.firmware.product,
    version: manifest.firmware.version,
    revision: manifest.firmware.reportedRevision,
    sourceCommit: manifest.firmware.sourceCommit,
    sha256: manifest.artifact.sha256,
    sizeBytes: manifest.artifact.sizeBytes,
    manifestSha256: imported.manifestSha256,
    hardwareQualification: manifest.build.hardwareQualification === 'qualified-on-zs407' ? 'qualified' : 'unqualified',
    ...(manifest.build.qualificationEvidenceSha256
      ? { qualificationEvidenceSha256: manifest.build.qualificationEvidenceSha256 }
      : {}),
    buildProvenance: {
      sourceRepository: manifest.firmware.sourceRepository,
      chibiosCommit: manifest.firmware.chibiosCommit,
      sourceDateEpoch: manifest.build.sourceDateEpoch,
      toolchain: manifest.build.toolchain,
      reproducibleCleanBuilds: manifest.build.reproducibleCleanBuilds,
      simulationQualification: manifest.build.simulationQualification,
    },
    transportIntegrity: 'local-manifest-sha256',
  });
}

export interface LocalFirmwareBuildRuntime {
  now(): Date;
  randomUuid(): string;
}

export type LocalFirmwareBuildStoreTestHooks = Readonly<{
  afterSourceStat?(path: string): Promise<void>;
}>;

/**
 * Native-main-only local build admission. The selected manifest and adjacent
 * BIN are untrusted input; both are opened without following symlinks,
 * validated, and copied create-once into application-owned content-addressed
 * storage. No renderer path enters this boundary.
 */
export class LocalFirmwareBuildStore {
  readonly #directory: string;
  readonly #customDirectory: string;

  constructor(
    directory: string,
    private readonly runtime: LocalFirmwareBuildRuntime = DEFAULT_RUNTIME,
    private readonly testHooks: LocalFirmwareBuildStoreTestHooks = {},
  ) {
    this.#directory = directory;
    this.#customDirectory = join(directory, 'custom-artifacts-v1');
  }

  async importManifest(selectedManifestPath: string): Promise<ImportedLocalFirmwareBuild> {
    await ensurePrivateFirmwareDirectory(this.#directory);
    if (!selectedManifestPath || selectedManifestPath.includes('\0')) throw new Error('Local firmware manifest path is invalid');
    const manifestBytes = await readSecureRegularFile(
      selectedManifestPath,
      MAXIMUM_MANIFEST_BYTES,
      'Local firmware manifest',
      this.testHooks,
    );
    const manifest = parseManifest(manifestBytes);
    const sourceArtifactPath = join(dirname(selectedManifestPath), manifest.artifact.filename);
    if (basename(sourceArtifactPath) !== manifest.artifact.filename) throw new Error('Local firmware artifact filename escapes its manifest directory');
    const artifactBytes = await readSecureRegularFile(
      sourceArtifactPath,
      ZS407_MAXIMUM_WRITE_BYTES,
      'Local firmware artifact',
      this.testHooks,
    );
    verifyLocalFirmwareBytes(manifest, artifactBytes);

    const manifestSha256 = sha256(manifestBytes);
    const importedAt = validNow(this.runtime.now()).toISOString();
    await ensureOwnedDirectory(this.#customDirectory);
    const artifactPath = join(this.#customDirectory, `${manifest.artifact.sha256}.bin`);
    const manifestPath = join(this.#customDirectory, `${manifest.artifact.sha256}.${manifestSha256}.manifest.json`);
    await installCreateOnce(artifactPath, artifactBytes, this.#customDirectory, this.runtime.randomUuid());
    await verifyOwnedFile(artifactPath, artifactBytes.byteLength, manifest.artifact.sha256, 'Imported local firmware artifact');
    await installCreateOnce(manifestPath, manifestBytes, this.#customDirectory, this.runtime.randomUuid());
    await verifyOwnedFile(manifestPath, manifestBytes.byteLength, manifestSha256, 'Imported local firmware manifest');
    return immutableImportedBuild({ manifest, manifestSha256, artifactPath, manifestPath, importedAt });
  }

  /** Reconstructs only the deterministic app-owned paths named by a v2 target. */
  async reopenTarget(targetValue: LocalCustomFirmwareTarget): Promise<ImportedLocalFirmwareBuild> {
    await ensurePrivateFirmwareDirectory(this.#directory);
    const target = localCustomFirmwareTargetSchema.parse(targetValue);
    await ensureOwnedDirectory(this.#customDirectory);
    const artifactPath = join(this.#customDirectory, `${target.sha256}.bin`);
    const manifestPath = join(this.#customDirectory, `${target.sha256}.${target.manifestSha256}.manifest.json`);
    const manifestBytes = await readOwnedRegularFile(
      manifestPath,
      MAXIMUM_MANIFEST_BYTES,
      'Imported local firmware manifest',
      (bytes) => {
        if (sha256(bytes) !== target.manifestSha256) throw new Error('Imported local firmware manifest digest changed');
      },
    );
    const manifest = parseManifest(manifestBytes);
    await readOwnedRegularFile(
      artifactPath,
      ZS407_MAXIMUM_WRITE_BYTES,
      'Imported local firmware artifact',
      (bytes) => verifyLocalFirmwareBytes(manifest, bytes),
      manifest.artifact.sizeBytes,
    );
    const reopened = immutableImportedBuild({
      manifest,
      manifestSha256: target.manifestSha256,
      artifactPath,
      manifestPath,
      importedAt: validNow(this.runtime.now()).toISOString(),
    });
    if (!isDeepStrictEqual(localCustomTargetForBuild(reopened), target)) {
      throw new Error('App-owned local firmware manifest does not reproduce the persisted custom target');
    }
    return reopened;
  }

  async readVerified(imported: ImportedLocalFirmwareBuild): Promise<Uint8Array> {
    const verified = await this.openVerified(imported);
    try {
      return verified.bytes;
    } finally {
      await verified.close();
    }
  }

  async openVerified(imported: ImportedLocalFirmwareBuild): Promise<VerifiedFirmwareArtifact> {
    await ensurePrivateFirmwareDirectory(this.#directory);
    const manifest = localFirmwareBuildManifestSchema.parse(imported.manifest);
    const expectedArtifactPath = join(this.#customDirectory, `${manifest.artifact.sha256}.bin`);
    const expectedManifestPath = join(this.#customDirectory, `${manifest.artifact.sha256}.${imported.manifestSha256}.manifest.json`);
    if (imported.artifactPath !== expectedArtifactPath || imported.manifestPath !== expectedManifestPath) {
      throw new Error('Imported local firmware paths do not match their content-addressed identity');
    }
    const manifestBytes = await readOwnedRegularFile(
      expectedManifestPath,
      MAXIMUM_MANIFEST_BYTES,
      'Imported local firmware manifest',
      (bytes) => {
        if (sha256(bytes) !== imported.manifestSha256) throw new Error('Imported local firmware manifest digest changed');
      },
    );
    const persistedManifest = parseManifest(manifestBytes);
    if (JSON.stringify(persistedManifest) !== JSON.stringify(manifest)) throw new Error('Imported local firmware manifest no longer matches its admitted value');
    return openVerifiedFirmwareFile(
      expectedArtifactPath,
      {
        label: 'Imported local firmware artifact',
        maximumBytes: ZS407_MAXIMUM_WRITE_BYTES,
        exactBytes: manifest.artifact.sizeBytes,
        requireSingleLink: true,
      },
      (bytes) => verifyLocalFirmwareBytes(manifest, bytes),
    );
  }
}

export function verifyLocalFirmwareBytes(manifestValue: LocalFirmwareBuildManifest, bytes: Uint8Array): void {
  const manifest = localFirmwareBuildManifestSchema.parse(manifestValue);
  if (bytes.byteLength !== manifest.artifact.sizeBytes) {
    throw new Error(`Local firmware has ${bytes.byteLength} bytes, expected ${manifest.artifact.sizeBytes}`);
  }
  const digest = sha256(bytes);
  if (digest !== manifest.artifact.sha256) throw new Error(`Local firmware SHA-256 ${digest} does not match manifest ${manifest.artifact.sha256}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stackPointer = view.getUint32(0, true);
  const resetHandler = view.getUint32(4, true);
  if (hex32(stackPointer) !== manifest.artifact.initialStackPointer) throw new Error('Local firmware initial stack pointer does not match its manifest');
  if (hex32(resetHandler) !== manifest.artifact.resetHandler) throw new Error('Local firmware reset handler does not match its manifest');
  const stackInSram = stackPointer >= 0x2000_0000 && stackPointer <= 0x2000_a000;
  const stackInCcm = stackPointer >= 0x1000_0000 && stackPointer <= 0x1000_2000;
  if ((stackPointer & 0b11) !== 0 || (!stackInSram && !stackInCcm)) {
    throw new Error(`Local firmware initial stack pointer ${hex32(stackPointer)} is outside STM32F303 ZS407 RAM`);
  }
  const resetAddress = resetHandler & ~1;
  if ((resetHandler & 1) !== 1
    || resetAddress < ZS407_LOAD_ADDRESS + 8
    || resetAddress >= ZS407_LOAD_ADDRESS + bytes.byteLength) {
    throw new Error(`Local firmware reset handler ${hex32(resetHandler)} is not Thumb code inside the image`);
  }
  const versionBytes = new TextEncoder().encode(manifest.firmware.version);
  if (!containsBytes(bytes, versionBytes)) throw new Error('Local firmware does not embed the exact manifested version string');
  const zs407Bytes = new TextEncoder().encode('+ ZS407');
  if (!containsBytes(bytes, zs407Bytes)) throw new Error('Local firmware does not embed the ZS407 hardware identity');
}

async function readSecureRegularFile(
  path: string,
  maximumBytes: number,
  label: string,
  testHooks: LocalFirmwareBuildStoreTestHooks,
): Promise<Uint8Array> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const before = await handle.stat();
    assertSecureMetadata(before, maximumBytes, label, path);
    await testHooks.afterSourceStat?.(path);
    const bytes = await positionedReadExactly(handle, before.size, label);
    const after = await handle.stat();
    if (!sameFileSnapshot(before, after) || bytes.byteLength !== before.size) throw new Error(`${label} changed while it was being read`);
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

function assertSecureMetadata(metadata: Stats, maximumBytes: number, label: string, path: string): void {
  if (!metadata.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
  if (!Number.isSafeInteger(metadata.size) || metadata.size <= 0 || metadata.size > maximumBytes) {
    throw new Error(`${label} size ${metadata.size} is outside the 1..${maximumBytes} byte bound`);
  }
  if (process.platform !== 'win32' && (metadata.mode & 0o022) !== 0) throw new Error(`${label} is writable by another user or group: ${path}`);
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) throw new Error(`${label} is not owned by the current user: ${path}`);
}

function sameFileSnapshot(before: Stats, after: Stats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

async function installCreateOnce(path: string, bytes: Uint8Array, directory: string, uuid: string): Promise<void> {
  const temporaryPath = join(directory, `.${basename(path)}.${z.string().uuid().parse(uuid)}.part`);
  let staged = false;
  let installed = false;
  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    staged = true;
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    try { await link(temporaryPath, path); installed = true; }
    catch (value) { if (!hasCode(value, 'EEXIST')) throw value; }
    // Once the final name may exist, retain the fsynced staging link until the
    // directory confirms that final-name durability. A failed sync is
    // deliberately visible and leaves forensic/retry evidence behind.
    if (installed) await syncDirectory(directory);
    await rm(temporaryPath);
    staged = false;
    await syncDirectory(directory);
  } finally {
    if (staged && !installed) await rm(temporaryPath, { force: true });
  }
}

async function verifyOwnedFile(path: string, size: number, digest: string, label: string): Promise<void> {
  try {
    await readOwnedRegularFile(
      path,
      Math.max(size, MAXIMUM_MANIFEST_BYTES),
      label,
      (bytes) => {
        if (sha256(bytes) !== digest) throw new Error('digest does not match the selected build');
      },
      size,
    );
  } catch (cause) {
    throw new Error(`${label} create-once collision does not match the selected build: ${message(cause)}`, { cause });
  }
}

async function readOwnedRegularFile(
  path: string,
  maximumBytes: number,
  label: string,
  verify: (bytes: Uint8Array) => void,
  exactBytes?: number,
): Promise<Uint8Array> {
  const verified = await openVerifiedFirmwareFile(
    path,
    { label, maximumBytes, ...(exactBytes === undefined ? {} : { exactBytes }), requireSingleLink: true },
    verify,
  );
  try {
    return verified.bytes;
  } finally {
    await verified.close();
  }
}

function parseManifest(bytes: Uint8Array): LocalFirmwareBuildManifest {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (cause) { throw new Error('Local firmware manifest is not strict UTF-8 JSON', { cause }); }
  return localFirmwareBuildManifestSchema.parse(value);
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let start = 0; start <= haystack.byteLength - needle.byteLength; start++) {
    for (let index = 0; index < needle.byteLength; index++) {
      if (haystack[start + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

function validNow(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('Local firmware clock returned an invalid Date');
  return value;
}

async function ensureOwnedDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Local firmware storage is not a regular directory: ${path}`);
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) throw new Error(`Local firmware storage is not owned by the current user: ${path}`);
  if (process.platform !== 'win32') {
    if ((metadata.mode & 0o077) !== 0) await chmod(path, 0o700);
    const tightened = await lstat(path);
    if ((tightened.mode & 0o077) !== 0) throw new Error(`Local firmware storage permissions are not owner-only: ${path}`);
  }
}

function immutableImportedBuild(value: ImportedLocalFirmwareBuild): ImportedLocalFirmwareBuild {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function hex32(value: number): string { return `0x${value.toString(16).padStart(8, '0')}`; }
function hasCode(value: unknown, code: string): boolean { return Boolean(value && typeof value === 'object' && 'code' in value && value.code === code); }
function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }

const DEFAULT_RUNTIME: LocalFirmwareBuildRuntime = {
  now: () => new Date(),
  randomUuid: () => randomUUID(),
};
