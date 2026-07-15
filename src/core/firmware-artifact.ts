import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, type BigIntStats } from 'node:fs';
import { link, open, rm, type FileHandle } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  OEM_ZS407_FIRMWARE_RELEASE,
  uuidSchema,
  type FirmwareArtifact,
} from './contracts.js';
import { ensurePrivateFirmwareDirectory, syncDirectory } from './persistence/durable-files.js';

export interface FirmwareArtifactTransportPort {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

export interface FirmwareArtifactVerificationPort {
  verify(bytes: Uint8Array): void;
}

export interface FirmwareArtifactClockPort {
  now(): Date;
}

export interface FirmwareArtifactIdentityPort {
  randomUuid(): string;
}

export interface FirmwareArtifactTimeAndIdentityPort
  extends FirmwareArtifactClockPort, FirmwareArtifactIdentityPort {}

export interface FirmwareArtifactRuntime
  extends FirmwareArtifactTransportPort, FirmwareArtifactVerificationPort, FirmwareArtifactTimeAndIdentityPort {}

/**
 * An exact regular-file description whose contents were read and verified by
 * positioned reads. The underlying descriptor remains open until close() so
 * it can be inherited by the dfu-util child without resolving a pathname
 * again. Positioned reads deliberately leave the shared file offset at zero.
 */
export interface VerifiedFirmwareArtifact {
  readonly descriptor: number;
  readonly bytes: Uint8Array;
  assertStable(): Promise<void>;
  close(): Promise<void>;
}

export interface VerifiedFirmwareFilePolicy {
  readonly label: string;
  readonly maximumBytes: number;
  readonly exactBytes?: number;
  readonly requireSingleLink?: boolean;
}

/**
 * Owns the untrusted network-to-filesystem artifact boundary. Callers receive
 * only an exact-length, digest-verified artifact or an exception; partial
 * downloads are never installed at the canonical path.
 */
export class FirmwareArtifactStore {
  readonly path: string;

  constructor(
    private readonly directory: string,
    private readonly runtime: FirmwareArtifactRuntime = DEFAULT_ARTIFACT_RUNTIME,
  ) {
    this.path = join(directory, `${OEM_ZS407_FIRMWARE_RELEASE.version}.bin`);
  }

  async download(): Promise<FirmwareArtifact> {
    await ensurePrivateFirmwareDirectory(this.directory);
    const existing = await this.inspect();
    if (existing) return existing;

    const temporaryPath = join(this.directory, `.${basename(this.path)}.${uuidSchema.parse(this.runtime.randomUuid())}.part`);
    let temporaryCreated = false;
    let canonicalInstalled = false;
    try {
      const response = await this.runtime.fetch(OEM_ZS407_FIRMWARE_RELEASE.downloadUrl, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        headers: { Accept: 'application/octet-stream' },
      });
      if (!response.ok) throw new Error(`OEM firmware server returned HTTP ${response.status}`);
      const declaredLength = response.headers.get('content-length');
      if (declaredLength !== String(OEM_ZS407_FIRMWARE_RELEASE.sizeBytes)) {
        throw new Error(`OEM firmware Content-Length ${declaredLength ?? 'missing'} does not match pinned ${OEM_ZS407_FIRMWARE_RELEASE.sizeBytes}`);
      }
      const bytes = await readResponseBodyBounded(response, OEM_ZS407_FIRMWARE_RELEASE.sizeBytes);
      this.runtime.verify(bytes);

      const handle = await open(temporaryPath, 'wx', 0o600);
      temporaryCreated = true;
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }

      try {
        // A same-directory hard link is an atomic create-once installation:
        // unlike rename(), it can never replace an existing canonical image.
        await link(temporaryPath, this.path);
        canonicalInstalled = true;
      } catch (value) {
        if (!hasCode(value, 'EEXIST')) throw value;
        try { await this.readVerified(); }
        catch (collision) {
          throw new Error(`Canonical firmware artifact collision was retained and rejected: ${message(collision)}`, { cause: collision });
        }
      }

      // Persist the create-once name before removing its staged sibling. A
      // crash can therefore leave an ignorable .part file, never a partial
      // canonical image and never a replacement of an existing image.
      await syncDirectory(this.directory);
      await rm(temporaryPath);
      temporaryCreated = false;
      await syncDirectory(this.directory);
      await this.readVerified();
      return artifactEvidence(this.runtime.now());
    } catch (value) {
      let cleanupFailure: unknown;
      if (temporaryCreated && !canonicalInstalled) {
        try { await rm(temporaryPath, { force: true }); }
        catch (cleanupValue) { cleanupFailure = cleanupValue; }
      }
      // A successfully linked canonical file is immutable application-owned
      // state. Cleanup failures must not tempt a caller to replace it; a retry
      // will verify and reuse it.
      if (!cleanupFailure) throw value;
      throw new Error(`${message(value)}. Temporary file cleanup also failed: ${message(cleanupFailure)}`, { cause: value });
    }
  }

  async inspect(): Promise<FirmwareArtifact | undefined> {
    await ensurePrivateFirmwareDirectory(this.directory);
    try {
      await this.readVerified();
      return artifactEvidence(this.runtime.now());
    } catch (value) {
      if (hasCode(value, 'ENOENT')) return undefined;
      throw value;
    }
  }

  async readVerified(): Promise<Uint8Array> {
    const verified = await this.openVerified();
    try {
      return verified.bytes;
    } finally {
      await verified.close();
    }
  }

  async openVerified(): Promise<VerifiedFirmwareArtifact> {
    await ensurePrivateFirmwareDirectory(this.directory);
    return openVerifiedFirmwareFile(
      this.path,
      {
        label: 'Canonical firmware artifact',
        maximumBytes: OEM_ZS407_FIRMWARE_RELEASE.sizeBytes,
        exactBytes: OEM_ZS407_FIRMWARE_RELEASE.sizeBytes,
        requireSingleLink: true,
      },
      (bytes) => this.runtime.verify(bytes),
    );
  }
}

/**
 * Opens and verifies one file description without ever handing verification a
 * pathname-derived second read. The before/after fstat snapshots detect
 * in-place mutation during verification; callers can repeat the stability
 * assertion immediately before spawning a descriptor-inheriting child.
 */
export async function openVerifiedFirmwareFile(
  path: string,
  policy: VerifiedFirmwareFilePolicy,
  verify: (bytes: Uint8Array) => void,
): Promise<VerifiedFirmwareArtifact> {
  if (!path || path.includes('\0')) throw new Error(`${policy.label} path is invalid`);
  if (!Number.isSafeInteger(policy.maximumBytes) || policy.maximumBytes <= 0) {
    throw new RangeError(`${policy.label} maximum byte bound is invalid`);
  }
  if (policy.exactBytes !== undefined
    && (!Number.isSafeInteger(policy.exactBytes) || policy.exactBytes <= 0 || policy.exactBytes > policy.maximumBytes)) {
    throw new RangeError(`${policy.label} exact byte count is invalid`);
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    const size = assertVerifiedFileMetadata(before, path, policy);
    const bytes = await positionedReadExactly(handle, size, policy.label);
    verify(bytes);
    const after = await handle.stat({ bigint: true });
    if (!sameFileSnapshot(before, after)) throw new Error(`${policy.label} changed while it was being verified`);
    const retainedHandle = handle;
    handle = undefined;
    let closed = false;
    return Object.freeze({
      descriptor: retainedHandle.fd,
      bytes,
      async assertStable(): Promise<void> {
        if (closed) throw new Error(`${policy.label} descriptor is already closed`);
        const current = await retainedHandle.stat({ bigint: true });
        if (!sameFileSnapshot(after, current)) throw new Error(`${policy.label} changed after it was verified`);
      },
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        await retainedHandle.close();
      },
    });
  } finally {
    await handle?.close();
  }
}

function assertVerifiedFileMetadata(
  metadata: BigIntStats,
  path: string,
  policy: VerifiedFirmwareFilePolicy,
): number {
  if (!metadata.isFile()) throw new Error(`${policy.label} is not a regular file: ${path}`);
  if (metadata.size <= 0n || metadata.size > BigInt(policy.maximumBytes)) {
    throw new Error(`${policy.label} size ${metadata.size} is outside the 1..${policy.maximumBytes} byte bound`);
  }
  if (policy.exactBytes !== undefined && metadata.size !== BigInt(policy.exactBytes)) {
    throw new Error(`${policy.label} has ${metadata.size} bytes, expected ${policy.exactBytes}`);
  }
  if (process.platform !== 'win32' && (metadata.mode & 0o022n) !== 0n) {
    throw new Error(`${policy.label} is writable by another user or group: ${path}`);
  }
  if (typeof process.getuid === 'function' && metadata.uid !== BigInt(process.getuid())) {
    throw new Error(`${policy.label} is not owned by the current user: ${path}`);
  }
  if (policy.requireSingleLink && metadata.nlink !== 1n) {
    throw new Error(`${policy.label} must have exactly one filesystem link: ${path}`);
  }
  return Number(metadata.size);
}

async function positionedReadExactly(handle: FileHandle, size: number, label: string): Promise<Uint8Array> {
  const bytes = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
    if (bytesRead <= 0) throw new Error(`${label} became shorter while it was being verified`);
    offset += bytesRead;
  }
  const probe = new Uint8Array(1);
  if ((await handle.read(probe, 0, 1, size)).bytesRead !== 0) {
    throw new Error(`${label} became longer while it was being verified`);
  }
  return bytes;
}

function sameFileSnapshot(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.mode === after.mode
    && before.nlink === after.nlink
    && before.uid === after.uid
    && before.gid === after.gid
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

export function verifyFirmwareArtifact(bytes: Uint8Array): void {
  if (bytes.byteLength !== OEM_ZS407_FIRMWARE_RELEASE.sizeBytes) {
    throw new Error(`Firmware has ${bytes.byteLength} bytes, expected ${OEM_ZS407_FIRMWARE_RELEASE.sizeBytes}`);
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== OEM_ZS407_FIRMWARE_RELEASE.sha256) {
    throw new Error(`Firmware SHA-256 ${actual} does not match pinned ${OEM_ZS407_FIRMWARE_RELEASE.sha256}`);
  }
}

export async function readResponseBodyBounded(response: Response, exactBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(exactBytes) || exactBytes < 0 || exactBytes > OEM_ZS407_FIRMWARE_RELEASE.sizeBytes) {
    throw new RangeError(`Firmware response byte bound must be an integer from 0 through ${OEM_ZS407_FIRMWARE_RELEASE.sizeBytes}`);
  }
  if (!response.body) throw new Error('OEM firmware response has no body');
  const output = new Uint8Array(exactBytes);
  const reader = response.body.getReader();
  let offset = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (offset + next.value.byteLength > exactBytes) {
        await reader.cancel('Pinned firmware byte bound exceeded');
        throw new Error(`OEM firmware body exceeds pinned ${exactBytes}-byte bound`);
      }
      output.set(next.value, offset);
      offset += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (offset !== exactBytes) throw new Error(`OEM firmware body has ${offset} bytes, expected exactly ${exactBytes}`);
  return output;
}

function artifactEvidence(now: Date): FirmwareArtifact {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Artifact clock returned an invalid Date');
  return {
    sizeBytes: OEM_ZS407_FIRMWARE_RELEASE.sizeBytes,
    sha256: OEM_ZS407_FIRMWARE_RELEASE.sha256,
    verifiedAt: now.toISOString(),
  };
}

function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function hasCode(value: unknown, code: string): boolean {
  return Boolean(value && typeof value === 'object' && 'code' in value && value.code === code);
}

const DEFAULT_ARTIFACT_RUNTIME: FirmwareArtifactRuntime = {
  fetch: (url, init) => globalThis.fetch(url, init),
  verify: verifyFirmwareArtifact,
  now: () => new Date(),
  randomUuid: () => randomUUID(),
};
