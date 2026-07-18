import { execFile, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import {
  canonicalDfuFingerprint,
  dfuIdentitySchema,
  inspectInternalFlashDescriptorContract,
  type DfuIdentity,
} from '../core/contracts.js';

const DFU_OBSERVATION_LIMIT = 2 * 1024 * 1024;
const DFU_STREAM_OBSERVATION_LIMIT = DFU_OBSERVATION_LIMIT / 2;
const PROGRESS_TAIL_LIMIT = 8_192;
const OBSERVATION_FAULT_DETAIL_LIMIT = 8;
export const DFU_FIRMWARE_CHILD_DESCRIPTOR = 3;

export const executableResultSchema = z.object({
  stdout: z.string().max(DFU_OBSERVATION_LIMIT),
  stderr: z.string().max(DFU_OBSERVATION_LIMIT),
}).strict();
export type ExecutableResult = z.infer<typeof executableResultSchema>;

export const dfuTransferProgressSchema = z.object({
  operation: z.enum(['erase', 'download']),
  percent: z.number().int().min(0).max(100),
}).strict();
export type DfuTransferProgress = z.infer<typeof dfuTransferProgressSchema>;

export const dfuExecutionResultSchema = executableResultSchema.extend({
  outputTruncated: z.boolean(),
  exceededExpectedDuration: z.boolean(),
}).strict();
export type DfuExecutionResult = z.infer<typeof dfuExecutionResultSchema>;

export const dfuUtilityPathSchema = z.string().trim().min(1).refine(isAbsolute, 'dfu-util path must be absolute');
export interface DfuInspection { deviceCount: number; identities: DfuIdentity[]; }

/** A parent-process descriptor for the exact already-verified firmware file. */
export interface DfuFirmwareDescriptor {
  readonly descriptor: number;
}

export interface DfuToolLocationPort {
  locateDfuUtility(): Promise<string | undefined>;
}

export interface DfuCommandExecutionPort {
  runExecutable(file: string, args: readonly string[], timeout: number): Promise<ExecutableResult>;
}

export interface DfuFlashExecutionPort {
  runDfuExecutable(
    file: string,
    args: readonly string[],
    expectedDuration: number,
    onProgress: (progress: DfuTransferProgress) => void,
    firmware: DfuFirmwareDescriptor,
  ): Promise<DfuExecutionResult>;
}

export interface DfuToolRuntime
  extends DfuToolLocationPort, DfuCommandExecutionPort, DfuFlashExecutionPort {}

export function inspectStm32DfuDevices(output: string): DfuInspection {
  const lines = output.split(/\r?\n/).filter((line) => /Found DFU:\s*\[0483:df11\]/i.test(line));
  const deviceFingerprints = new Set<string>();
  const identities: DfuIdentity[] = [];
  for (const rawLine of lines) {
    const targetLine = bounded(rawLine);
    const path = targetLine.match(/\bpath="([^"]+)"/i)?.[1];
    const devnum = targetLine.match(/\bdevnum=(\d+)\b/i)?.[1];
    const serial = targetLine.match(/\bserial="([^"]*)"/i)?.[1];
    const altText = targetLine.match(/\balt=(\d+)\b/i)?.[1];
    const name = targetLine.match(/\bname="([^"]+)"/i)?.[1];
    if (!path || !devnum || !serial || altText === undefined || !name) {
      throw new Error(`Malformed or empty STM32 DFU identity line: ${targetLine}`);
    }
    deviceFingerprints.add(JSON.stringify({ path, devnum, serial }));
    if (Number(altText) !== 0 || !name.startsWith('@Internal Flash')) continue;
    inspectInternalFlashDescriptor(name);
    const candidate = { path, devnum, serial, alt: 0 as const, name, targetLine };
    identities.push(dfuIdentitySchema.parse({ ...candidate, fingerprint: canonicalDfuFingerprint(candidate) }));
  }
  return { deviceCount: deviceFingerprints.size, identities };
}

export function exactOneDfuIdentity(inspection: DfuInspection): DfuIdentity | undefined {
  if (inspection.deviceCount > 1) {
    throw new Error(`Detected ${inspection.deviceCount} STM32 DFU devices; exactly one physical device is required`);
  }
  if (inspection.deviceCount === 1 && inspection.identities.length !== 1) {
    throw new Error(`The STM32 DFU device exposes ${inspection.identities.length} exact alt-0 internal-flash targets; exactly one is required`);
  }
  return inspection.deviceCount === 1 ? inspection.identities[0] : undefined;
}

export function parseDfuUtilVersion(output: string): string {
  const versionLine = output.split(/\r?\n/).map((line) => line.trim()).find((line) => /^dfu-util\b/i.test(line));
  const version = versionLine?.match(/^dfu-util\s+(\S+)$/i)?.[1];
  if (version !== '0.11') {
    throw new Error(`dfu-util version ${version ?? 'missing'} is unsupported; Flasher requires 0.11`);
  }
  return version;
}

export function inspectInternalFlashDescriptor(name: string): { startAddress: number; capacityBytes: number } {
  return inspectInternalFlashDescriptorContract(name);
}

export function parseDfuTransferProgress(output: string): DfuTransferProgress | undefined {
  const matches = [...output.matchAll(/(?:^|[\r\n])(Erase|Download)\s+\[[^\]]*\]\s+(\d{1,3})%/gim)];
  const match = matches.at(-1);
  if (!match) return undefined;
  const percent = Number(match[2]);
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) return undefined;
  return dfuTransferProgressSchema.parse({ operation: match[1]!.toLowerCase(), percent });
}

/**
 * Recognizes the two complete, canonical dfu-util 0.11 success lines. Partial
 * text, prefixes, and one of the two lines alone are deliberately insufficient.
 */
export function hasExactDfuDownloadConfirmation(output: string): boolean {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const downloadDone = lines.indexOf('Download done.');
  const fileSucceeded = lines.indexOf('File downloaded successfully', downloadDone + 1);
  return downloadDone >= 0 && fileSucceeded > downloadDone;
}

export async function locateDfuUtility(
  explicitPath: string | undefined = process.env.TINYSA_DFU_UTIL,
  executableSearchPath: string = process.env.PATH ?? '',
): Promise<string | undefined> {
  const explicit = explicitPath?.trim();
  if (explicit) {
    if (!isAbsolute(explicit)) throw new Error(`TINYSA_DFU_UTIL must be an absolute executable path: ${explicit}`);
    if (!await isExecutableFile(explicit)) throw new Error(`TINYSA_DFU_UTIL is not an executable regular file: ${explicit}`);
    return explicit;
  }
  const candidates = [
    '/opt/homebrew/bin/dfu-util',
    '/usr/local/bin/dfu-util',
    '/usr/bin/dfu-util',
    ...executableSearchPath.split(delimiter).filter(isAbsolute).map((directory) => join(directory, 'dfu-util')),
  ];
  for (const candidate of [...new Set(candidates)]) {
    if (await isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

export function runExecutable(
  file: string,
  args: readonly string[],
  timeout: number,
): Promise<ExecutableResult> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout, maxBuffer: DFU_OBSERVATION_LIMIT, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${file} ${args.join(' ')} failed: ${bounded(stderr || stdout || error.message)}`, { cause: error }));
      else resolve(executableResultSchema.parse({ stdout, stderr }));
    });
  });
}

export async function runDfuExecutable(
  file: string,
  args: readonly string[],
  expectedDuration: number,
  onProgress: (progress: DfuTransferProgress) => void,
  firmware: DfuFirmwareDescriptor,
): Promise<DfuExecutionResult> {
  if (args.some((argument) => argument.startsWith('-D') || argument.startsWith('--download'))) {
    throw new Error('dfu-util download input is supplied only by the verified descriptor boundary');
  }
  if (!Number.isSafeInteger(firmware.descriptor) || firmware.descriptor <= 2) {
    throw new Error('Verified firmware descriptor must be an open non-stdio file descriptor');
  }
  const downloadPath = inheritedDfuFirmwarePath();
  const childArgs = [...args, '-D', downloadPath];
  let child;
  try {
    child = spawn(file, childArgs, {
      // The numeric parent descriptor is duplicated as fd 3 in the child.
      // No mutable firmware pathname is ever resolved by dfu-util.
      stdio: ['ignore', 'pipe', 'pipe', firmware.descriptor],
    });
  } catch (value) {
    throw new Error(`${file} ${childArgs.join(' ')} could not start: ${safeMessage(value)}`, { cause: value });
  }
  return observeDfuExecution(child as ObservableDfuChild, file, childArgs, expectedDuration, onProgress);
}

export function inheritedDfuFirmwarePath(platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new Error(`Descriptor-bound dfu-util firmware input is unsupported on ${platform}; flashing is disabled`);
  }
  return `/dev/fd/${DFU_FIRMWARE_CHILD_DESCRIPTOR}`;
}

interface ObservableDfuStream {
  on(event: 'data', listener: (chunk: unknown) => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
}

interface ObservableDfuChild {
  stdout: ObservableDfuStream;
  stderr: ObservableDfuStream;
  once(event: 'error', listener: (error: unknown) => void): unknown;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export function observeDfuExecution(
  child: ObservableDfuChild,
  file: string,
  args: readonly string[],
  expectedDuration: number,
  onProgress: (progress: DfuTransferProgress) => void,
  parseProgress: (output: string) => DfuTransferProgress | undefined = parseDfuTransferProgress,
): Promise<DfuExecutionResult> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let progressTail = '';
    let lastProgress = '';
    let outputTruncated = false;
    let exceededExpectedDuration = false;
    let settled = false;
    let observationFaultCount = 0;
    let progressObservationEnabled = true;
    const observationFaults: string[] = [];
    const durationTimer = setTimeout(() => { exceededExpectedDuration = true; }, expectedDuration);

    const recordObservationFault = (source: string, value: unknown) => {
      observationFaultCount += 1;
      if (observationFaults.length < OBSERVATION_FAULT_DETAIL_LIMIT) {
        observationFaults.push(`${source}: ${bounded(safeMessage(value))}`);
      }
    };

    const consume = (stream: 'stdout' | 'stderr', chunk: unknown) => {
      try {
        const text = decodeOutputChunk(chunk);
        if (stream === 'stdout') ({ value: stdout, truncated: outputTruncated } = appendBounded(stdout, text, outputTruncated));
        else ({ value: stderr, truncated: outputTruncated } = appendBounded(stderr, text, outputTruncated));
        progressTail = `${progressTail}${text.slice(-PROGRESS_TAIL_LIMIT)}`.slice(-PROGRESS_TAIL_LIMIT);
        if (!progressObservationEnabled) return;
        let progress: DfuTransferProgress | undefined;
        try {
          const parsed = parseProgress(progressTail);
          progress = parsed === undefined ? undefined : dfuTransferProgressSchema.parse(parsed);
        }
        catch (value) {
          progressObservationEnabled = false;
          recordObservationFault('progress parser', value);
          return;
        }
        const key = progress ? `${progress.operation}:${progress.percent}` : '';
        if (progress && key !== lastProgress) {
          lastProgress = key;
          try {
            const callbackResult = onProgress(progress) as unknown;
            if (isPromiseLike(callbackResult)) {
              void Promise.resolve(callbackResult).catch(() => undefined);
              throw new Error('Progress callback must complete synchronously');
            }
          }
          catch (value) {
            progressObservationEnabled = false;
            recordObservationFault('progress callback', value);
          }
        }
      } catch (value) {
        progressObservationEnabled = false;
        recordObservationFault(`${stream} data`, value);
      }
    };

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(durationTimer);
      reject(new Error(`${file} ${args.join(' ')} could not start: ${safeMessage(error)}`, { cause: error }));
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(durationTimer);
      try {
        if (observationFaults.length) {
          const omitted = observationFaultCount - observationFaults.length;
          const faultSummary = `${observationFaults.join('; ')}${omitted > 0 ? `; ${omitted} additional fault(s) omitted` : ''}`;
          reject(new Error(`${file} ${args.join(' ')} exited with code ${String(code)} signal ${signal ?? 'none'} after an output-observation fault; write completion is indeterminate: ${faultSummary}`));
          return;
        }
        if (code !== 0) {
          reject(new Error(`${file} ${args.join(' ')} failed with code ${String(code)} signal ${signal ?? 'none'}: ${bounded(stderr || stdout)}`));
          return;
        }
        resolve(dfuExecutionResultSchema.parse({ stdout, stderr, outputTruncated, exceededExpectedDuration }));
      } catch (value) {
        reject(new Error(`${file} ${args.join(' ')} exited, but final observation failed; write completion is indeterminate: ${bounded(safeMessage(value))}`, { cause: value }));
      }
    });
    try { child.stdout.on('data', (chunk) => consume('stdout', chunk)); }
    catch (value) { recordObservationFault('stdout data observer setup', value); }
    try { child.stderr.on('data', (chunk) => consume('stderr', chunk)); }
    catch (value) { recordObservationFault('stderr data observer setup', value); }
    try { child.stdout.on('error', (error) => { recordObservationFault('stdout', error); }); }
    catch (value) { recordObservationFault('stdout error observer setup', value); }
    try { child.stderr.on('error', (error) => { recordObservationFault('stderr', error); }); }
    catch (value) { recordObservationFault('stderr error observer setup', value); }
    // Once the child may have crossed the write boundary, neither expected
    // duration nor output volume is allowed to terminate it. Observation is
    // bounded in memory and continues until the process reports its own exit.
  });
}

function appendBounded(existing: string, addition: string, alreadyTruncated: boolean): { value: string; truncated: boolean } {
  const existingBytes = Buffer.from(existing, 'utf8');
  const additionBytes = Buffer.from(addition, 'utf8');
  if (existingBytes.byteLength + additionBytes.byteLength <= DFU_STREAM_OBSERVATION_LIMIT) {
    return { value: existing + addition, truncated: alreadyTruncated };
  }
  const retainedAddition = additionBytes.subarray(Math.max(0, additionBytes.byteLength - DFU_STREAM_OBSERVATION_LIMIT));
  const existingAllowance = DFU_STREAM_OBSERVATION_LIMIT - retainedAddition.byteLength;
  const retainedExisting = existingBytes.subarray(Math.max(0, existingBytes.byteLength - existingAllowance));
  const retained = Buffer.concat([retainedExisting, retainedAddition], DFU_STREAM_OBSERVATION_LIMIT);
  return { value: retained.toString('utf8'), truncated: true };
}

function decodeOutputChunk(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8');
  throw new TypeError(`DFU output emitted an unsupported ${typeof chunk} chunk`);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value && (typeof value === 'object' || typeof value === 'function') && 'then' in value
    && typeof (value as { then?: unknown }).then === 'function');
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) return false;
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function bounded(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 20_000);
}
function safeMessage(value: unknown): string {
  try { return String(value instanceof Error ? value.message : value); }
  catch { return 'unprintable error'; }
}

export const DEFAULT_DFU_TOOL_RUNTIME: DfuToolRuntime = Object.freeze({
  locateDfuUtility,
  runExecutable,
  runDfuExecutable,
});
