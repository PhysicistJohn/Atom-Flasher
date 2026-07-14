import { describe, expect, it } from 'vitest';
import { OperationGate } from '../src/main/operation-gate.js';

describe('main-process operation gate', () => {
  it('rejects overlapping mutations while allowing synchronous snapshots', async () => {
    const gate = new OperationGate();
    let release!: () => void;
    const first = gate.run('flash', () => new Promise<string>((resolve) => { release = () => resolve('done'); }));
    expect(gate.active).toBe('flash');
    expect(gate.peek(() => 'progress')).toBe('progress');
    let becameIdle = false;
    const idle = gate.whenIdle().then(() => { becameIdle = true; });
    await expect(gate.run('disconnect', () => 'unsafe overlap')).rejects.toThrow(/flash is already active/);
    expect(becameIdle).toBe(false);
    release();
    await expect(first).resolves.toBe('done');
    await idle;
    expect(becameIdle).toBe(true);
    await expect(gate.run('disconnect', () => 'safe')).resolves.toBe('safe');
  });
});
