import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEVELOPMENT_HOST_LIFETIME_FD_ENV,
  DevelopmentHostLifetime,
  developmentHostLifetimeDescriptor,
} from '../src/main/development-host-lifetime.js';

const childProcesses = new Set<number>();
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const pid of childProcesses) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ }
  }
  childProcesses.clear();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('development host lifetime authority', () => {
  it('requires an inherited non-stdio descriptor only for unpackaged live renderers', () => {
    expect(developmentHostLifetimeDescriptor({}, true, true)).toBeUndefined();
    expect(developmentHostLifetimeDescriptor({}, false, false)).toBeUndefined();
    expect(developmentHostLifetimeDescriptor({ [DEVELOPMENT_HOST_LIFETIME_FD_ENV]: '3' }, false, true)).toBe(3);
    expect(() => developmentHostLifetimeDescriptor({}, false, true)).toThrow(/must name an inherited/i);
    expect(() => developmentHostLifetimeDescriptor({ [DEVELOPMENT_HOST_LIFETIME_FD_ENV]: '2' }, false, true)).toThrow(/3 through 255/i);
    expect(() => developmentHostLifetimeDescriptor({ [DEVELOPMENT_HOST_LIFETIME_FD_ENV]: '3x' }, false, true)).toThrow(/must name an inherited/i);
  });

  it('revokes once on EOF and cannot be made available again', async () => {
    const stream = new PassThrough();
    const lost = vi.fn();
    const lifetime = new DevelopmentHostLifetime(3, lost, () => stream);

    expect(lifetime.available).toBe(true);
    stream.end();
    await vi.waitFor(() => expect(lifetime.available).toBe(false));
    expect(lost).toHaveBeenCalledOnce();
    expect(lost.mock.calls[0]?.[0]).toMatch(/EOF/i);
    expect(() => lifetime.assertAvailable()).toThrow(/permanently quarantined/i);
    stream.emit('close');
    expect(lost).toHaveBeenCalledOnce();
  });

  it('treats payload or channel error as authority loss while normal disposal is silent', async () => {
    const payloadStream = new PassThrough();
    const payloadLost = vi.fn();
    const payloadLifetime = new DevelopmentHostLifetime(3, payloadLost, () => payloadStream);
    payloadStream.write('unexpected');
    await vi.waitFor(() => expect(payloadLifetime.available).toBe(false));
    expect(payloadLost).toHaveBeenCalledWith(expect.stringMatching(/unexpected data/i));

    const disposedStream = new PassThrough();
    const disposedLost = vi.fn();
    const disposedLifetime = new DevelopmentHostLifetime(3, disposedLost, () => disposedStream);
    disposedLifetime.dispose();
    disposedStream.emit('close');
    expect(disposedLifetime.available).toBe(false);
    expect(disposedLost).not.toHaveBeenCalled();
  });

  it('keeps authority revoked without crashing when adapter cleanup throws', async () => {
    const stream = new PassThrough();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const lifetime = new DevelopmentHostLifetime(3, () => { throw new Error('forced cleanup failure'); }, () => stream);
      stream.end();
      await vi.waitFor(() => expect(lifetime.available).toBe(false));
      expect(() => lifetime.assertAvailable()).toThrow(/permanently quarantined/i);
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(/cleanup failed/i),
        expect.objectContaining({ message: 'forced cleanup failure' }),
      );
    } finally {
      log.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')('observes kernel EOF when the development host is killed with SIGKILL', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tinysa-dev-host-lifetime-'));
    temporaryDirectories.push(directory);
    const readyPath = join(directory, 'ready');
    const lostPath = join(directory, 'lost');
    const moduleUrl = pathToFileURL(join(process.cwd(), 'src/main/development-host-lifetime.ts')).href;
    const monitorSource = `
      import { writeFileSync } from 'node:fs';
      import { DevelopmentHostLifetime } from ${JSON.stringify(moduleUrl)};
      new DevelopmentHostLifetime(3, (reason) => {
        writeFileSync(${JSON.stringify(lostPath)}, reason);
        process.exit(0);
      });
      writeFileSync(${JSON.stringify(readyPath)}, String(process.pid));
      setInterval(() => {}, 1000);
    `;
    const hostSource = `
      import { spawn } from 'node:child_process';
      const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', ${JSON.stringify(monitorSource)}], {
        stdio: ['ignore', 'ignore', 'inherit', 'pipe'],
      });
      child.stdio[3].unref();
      setInterval(() => {}, 1000);
    `;
    const host = spawn(process.execPath, ['--input-type=module', '-e', hostSource], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    if (!host.pid) throw new Error('Could not start development-host lifetime fixture');
    childProcesses.add(host.pid);
    await waitForFile(readyPath);
    const monitorPid = Number(await readFile(readyPath, 'utf8'));
    if (!Number.isSafeInteger(monitorPid) || monitorPid <= 0) throw new Error('Lifetime fixture returned an invalid monitor PID');
    childProcesses.add(monitorPid);

    const hostExit = once(host, 'exit');
    process.kill(host.pid, 'SIGKILL');
    await hostExit;
    childProcesses.delete(host.pid);
    const reason = await waitForFile(lostPath);
    expect(reason).toMatch(/EOF|closed/i);
    await waitForExit(monitorPid);
    childProcesses.delete(monitorPid);
  }, 10_000);
});

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { return await readFile(path, 'utf8'); }
    catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Process ${pid} did not exit after lifetime loss`);
}
