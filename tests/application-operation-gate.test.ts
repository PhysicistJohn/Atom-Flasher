import { describe, expect, it, vi } from 'vitest';
import { OperationGate } from '../src/application/operation-gate.js';

describe('application operation gate', () => {
  it('admits one mutation, rejects overlap, and still permits synchronous observation', async () => {
    const gate = new OperationGate();
    const entered = deferred<void>();
    const release = deferred<string>();
    const first = gate.run('firmware-write', async () => {
      entered.resolve();
      return release.promise;
    });
    await entered.promise;

    expect(gate.active).toBe('firmware-write');
    expect(gate.peek(() => ({ progress: 42 }))).toEqual({ progress: 42 });
    const overlap = vi.fn(() => 'must not run');
    await expect(gate.run('disconnect', overlap)).rejects.toThrow(/firmware-write is already active.*disconnect was not started/i);
    expect(overlap).not.toHaveBeenCalled();

    release.resolve('complete');
    await expect(first).resolves.toBe('complete');
    expect(gate.active).toBeUndefined();
  });

  it('releases every idle waiter only after the operation settles', async () => {
    const gate = new OperationGate();
    const release = deferred<void>();
    const operation = gate.run('scan', () => release.promise);
    const firstWaiter = vi.fn();
    const secondWaiter = vi.fn();
    const firstIdle = gate.whenIdle().then(firstWaiter);
    const secondIdle = gate.whenIdle().then(secondWaiter);

    await Promise.resolve();
    expect(firstWaiter).not.toHaveBeenCalled();
    expect(secondWaiter).not.toHaveBeenCalled();
    release.resolve();
    await operation;
    await Promise.all([firstIdle, secondIdle]);
    expect(firstWaiter).toHaveBeenCalledOnce();
    expect(secondWaiter).toHaveBeenCalledOnce();
    await expect(gate.whenIdle()).resolves.toBeUndefined();
  });

  it.each([
    ['synchronous', () => { throw new Error('sync failure'); }],
    ['asynchronous', async () => { throw new Error('async failure'); }],
  ] as const)('clears ownership after a %s failure', async (_kind, fail) => {
    const gate = new OperationGate();
    await expect(gate.run('failing-operation', fail)).rejects.toThrow(/failure/);
    expect(gate.active).toBeUndefined();
    await expect(gate.run('recovery', () => 'safe')).resolves.toBe('safe');
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
