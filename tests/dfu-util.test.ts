import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hasExactDfuDownloadConfirmation,
  dfuUtilityPathSchema,
  locateDfuUtility,
  observeDfuExecution,
  parseDfuTransferProgress,
  inheritedDfuFirmwarePath,
  runDfuExecutable,
} from '../src/dfu/dfu-util.js';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('dfu-util executable boundary', () => {
  it('accepts only an absolute executable regular file as an explicit utility', async () => {
    const root = await temporaryDirectory();
    const executable = join(root, 'dfu-util');
    await writeFile(executable, '#!/bin/sh\nexit 0\n');
    await chmod(executable, 0o700);

    await expect(locateDfuUtility(executable, '')).resolves.toBe(executable);
    await expect(locateDfuUtility('./dfu-util', '')).rejects.toThrow(/absolute executable path/i);

    const directory = join(root, 'not-a-program');
    await mkdir(directory);
    await chmod(directory, 0o700);
    await expect(locateDfuUtility(directory, '')).rejects.toThrow(/executable regular file/i);

    const nonExecutable = join(root, 'not-executable');
    await writeFile(nonExecutable, 'no');
    await chmod(nonExecutable, 0o600);
    await expect(locateDfuUtility(nonExecutable, '')).rejects.toThrow(/executable regular file/i);
    expect(() => dfuUtilityPathSchema.parse('./dfu-util')).toThrow(/absolute/i);
  });

  it('inherits only the verified descriptor and never reopens a substituted pathname', async () => {
    if (process.platform !== 'darwin' && process.platform !== 'linux') return;
    const root = await temporaryDirectory();
    const imagePath = join(root, 'firmware.bin');
    const scriptPath = join(root, 'read-inherited-firmware.mjs');
    const exactBytes = new TextEncoder().encode('exact-verified-firmware');
    await writeFile(imagePath, exactBytes, { mode: 0o600 });
    await writeFile(scriptPath, [
      "import { readFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const marker = args.indexOf('-D');",
      "if (marker < 0 || args[marker + 1] !== '/dev/fd/3') process.exit(91);",
      "const bytes = readFileSync(args[marker + 1]);",
      "process.stdout.write(`artifact:${bytes.toString('utf8')}\\nDownload done.\\nFile downloaded successfully\\n`);",
    ].join('\n'), { mode: 0o600 });
    const verifiedHandle = await open(imagePath, 'r');
    try {
      await rm(imagePath);
      await writeFile(imagePath, 'substituted-path-content', { mode: 0o600 });
      const result = await runDfuExecutable(
        process.execPath,
        [scriptPath],
        10_000,
        () => undefined,
        { descriptor: verifiedHandle.fd },
      );
      expect(result.stdout).toContain('artifact:exact-verified-firmware');
      expect(result.stdout).not.toContain('substituted-path-content');
    } finally {
      await verifiedHandle.close();
    }
  });

  it('rejects path-based download arguments and unsupported descriptor platforms', async () => {
    await expect(runDfuExecutable(
      process.execPath,
      ['-D', '/tmp/mutable.bin'],
      10_000,
      () => undefined,
      { descriptor: 41 },
    )).rejects.toThrow(/only by the verified descriptor boundary/i);
    expect(inheritedDfuFirmwarePath('darwin')).toBe('/dev/fd/3');
    expect(inheritedDfuFirmwarePath('linux')).toBe('/dev/fd/3');
    expect(() => inheritedDfuFirmwarePath('win32')).toThrow(/unsupported.*flashing is disabled/i);
  });
});

describe('dfu-util confirmation and progress parsing', () => {
  it('requires both exact complete success lines', () => {
    expect(hasExactDfuDownloadConfirmation('Download done.\nFile downloaded successfully')).toBe(true);
    expect(hasExactDfuDownloadConfirmation('  Download done.\r\n File downloaded successfully  ')).toBe(true);
    expect(hasExactDfuDownloadConfirmation('Download done.')).toBe(false);
    expect(hasExactDfuDownloadConfirmation('File downloaded successfully')).toBe(false);
    expect(hasExactDfuDownloadConfirmation('prefix Download done.\nFile downloaded successfully suffix')).toBe(false);
    expect(hasExactDfuDownloadConfirmation('Download done!\nFile downloaded successfully')).toBe(false);
    expect(hasExactDfuDownloadConfirmation('File downloaded successfully\nDownload done.')).toBe(false);
  });

  it('accepts only bounded erase/download percentages at line boundaries', () => {
    expect(parseDfuTransferProgress('\rErase [====] 0%')).toEqual({ operation: 'erase', percent: 0 });
    expect(parseDfuTransferProgress('\nDownload [====] 100%')).toEqual({ operation: 'download', percent: 100 });
    expect(parseDfuTransferProgress('spoof Download [====] 100%')).toBeUndefined();
    expect(parseDfuTransferProgress('\rDownload [====] 101%')).toBeUndefined();
  });
});

describe('dfu-util post-spawn observation', () => {
  it('bounds both output streams in aggregate without terminating the child', async () => {
    const child = new FakeDfuChild();
    const progress = vi.fn();
    const observed = observeDfuExecution(child, '/fixture/dfu-util', ['-D', 'image.bin'], 10_000, progress);

    child.stdout.emit('data', Buffer.alloc(2 * 1024 * 1024, 0x61));
    child.stderr.emit('data', Buffer.alloc(2 * 1024 * 1024, 0x62));
    child.stderr.emit('data', Buffer.from('\rDownload [=====] 100%\nFile downloaded successfully\n'));
    child.emit('close', 0, null);

    const result = await observed;
    expect(result.outputTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(result.stderr).toMatch(/File downloaded successfully/);
    expect(progress).toHaveBeenLastCalledWith({ operation: 'download', percent: 100 });
    expect(child.killed).toBe(false);
  });

  it('turns a progress callback exception into an indeterminate result only after close', async () => {
    const child = new FakeDfuChild();
    const observed = observeDfuExecution(child, '/fixture/dfu-util', ['-D', 'image.bin'], 10_000, () => {
      throw new Error('renderer progress consumer failed');
    });
    const settled = vi.fn();
    void observed.then(settled, settled);

    expect(() => child.stderr.emit('data', Buffer.from('\rDownload [=====] 40%'))).not.toThrow();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(() => child.stderr.emit('data', Buffer.from('\rDownload [=====] 100%'))).not.toThrow();
    child.emit('close', 0, null);

    await expect(observed).rejects.toThrow(/completion is indeterminate: progress callback.*renderer progress consumer failed/i);
    expect(child.killed).toBe(false);
  });

  it('turns a progress parser exception into an indeterminate result only after close', async () => {
    const child = new FakeDfuChild();
    const parser = vi.fn(() => { throw new Error('progress grammar fault'); });
    const observed = observeDfuExecution(
      child,
      '/fixture/dfu-util',
      ['-D', 'image.bin'],
      10_000,
      () => undefined,
      parser,
    );
    const settled = vi.fn();
    void observed.then(settled, settled);

    expect(() => child.stdout.emit('data', Buffer.from('\rErase [=] 1%'))).not.toThrow();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    child.emit('close', 0, null);

    await expect(observed).rejects.toThrow(/completion is indeterminate: progress parser.*progress grammar fault/i);
    expect(parser).toHaveBeenCalledTimes(1);
  });

  it('contains a rejected asynchronous progress callback and marks observation indeterminate', async () => {
    const child = new FakeDfuChild();
    const observed = observeDfuExecution(child, '/fixture/dfu-util', ['-D', 'image.bin'], 10_000, async () => {
      throw new Error('asynchronous progress rejection');
    });

    expect(() => child.stdout.emit('data', Buffer.from('\rDownload [=====] 25%'))).not.toThrow();
    await Promise.resolve();
    child.emit('close', 0, null);

    await expect(observed).rejects.toThrow(/completion is indeterminate: progress callback.*must complete synchronously/i);
  });

  it('keeps observing after a pipe fault and rejects indeterminate on close', async () => {
    const child = new FakeDfuChild();
    const observed = observeDfuExecution(child, '/fixture/dfu-util', ['-D', 'image.bin'], 10_000, () => undefined);
    const settled = vi.fn();
    void observed.then(settled, settled);

    expect(() => child.stdout.emit('error', new Error('stdout pipe failed'))).not.toThrow();
    child.stderr.emit('data', Buffer.from('later diagnostic output'));
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    child.emit('close', 74, null);

    await expect(observed).rejects.toThrow(/output-observation fault.*completion is indeterminate.*stdout pipe failed/i);
    expect(child.killed).toBe(false);
  });

  it('rejects a process start fault without waiting for a nonexistent close', async () => {
    const child = new FakeDfuChild();
    const observed = observeDfuExecution(child, '/missing/dfu-util', ['-D', 'image.bin'], 10_000, () => undefined);
    expect(() => child.emit('error', new Error('spawn ENOENT'))).not.toThrow();
    await expect(observed).rejects.toThrow(/could not start.*spawn ENOENT/i);
  });

  it('contains malformed output chunks and waits for close', async () => {
    const child = new FakeDfuChild();
    const observed = observeDfuExecution(child, '/fixture/dfu-util', ['-D', 'image.bin'], 10_000, () => undefined);
    expect(() => child.stdout.emit('data', { unexpected: true })).not.toThrow();
    child.emit('close', 0, null);
    await expect(observed).rejects.toThrow(/completion is indeterminate: stdout data.*unsupported object chunk/i);
  });
});

class FakeDfuChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
}

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tinysa-dfu-test-'));
  roots.push(root);
  return root;
}
