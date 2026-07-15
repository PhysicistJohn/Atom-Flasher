import { describe, expect, it, vi } from 'vitest';
import { CommandScheduler, extractFixedBinaryResponse, extractTextResponse, type ByteTransport, type TransportEvent } from '../src/device/protocol.js';

const bytes = (value: string) => new TextEncoder().encode(value);

describe('tinySA serial response framing', () => {
  it('requires the exact command echo and shell prompt', () => {
    const frame = bytes('version\r\ntinySA4_v1.4-224-gc979386\r\nch> ');
    expect(extractTextResponse(frame, 'version')).toEqual({
      value: 'tinySA4_v1.4-224-gc979386',
      consumedBytes: frame.length,
    });
    expect(extractTextResponse(bytes('other\r\nvalue\r\nch> '), 'version')).toBeUndefined();
  });

  it('does not scan through a fixed binary payload for a coincidental prompt', () => {
    const prefix = bytes('capture\r\n');
    const payload = Uint8Array.of(1, 2, 3, 4);
    const prompt = bytes('ch> ');
    const response = new Uint8Array(prefix.length + payload.length + prompt.length);
    response.set(prefix); response.set(payload, prefix.length); response.set(prompt, prefix.length + payload.length);
    expect(extractFixedBinaryResponse(response, 'capture', 4)?.value).toEqual(payload);
    expect(() => extractFixedBinaryResponse(bytes('capture\r\nch> xxxx'), 'capture', 4)).toThrow(/exact shell prompt/);
  });

  it('never lets a stale frame satisfy a newly issued safety command', async () => {
    const transport = new SchedulerTransport();
    const scheduler = new CommandScheduler(transport);
    transport.emitBytes(bytes('output off\r\nch> '));

    await expect(scheduler.execute('output off')).rejects.toThrow(/unsolicited serial bytes/i);
    expect(transport.writes).toEqual([]);
    scheduler.dispose();
  });

  it('flushes stale host input before opening each exact response window', async () => {
    const transport = new SchedulerTransport();
    const scheduler = new CommandScheduler(transport);
    const response = scheduler.execute('output off');

    await vi.waitFor(() => expect(transport.writes).toEqual(['output off\r']));
    transport.emitBytes(bytes('output off\r\nch> '));
    await expect(response).resolves.toBe('');
    expect(transport.discards).toBe(1);
    scheduler.dispose();
  });

  it('faults immediately when the transport closes during a command', async () => {
    const transport = new SchedulerTransport();
    const scheduler = new CommandScheduler(transport);
    const response = scheduler.execute('version');
    await vi.waitFor(() => expect(transport.writes).toHaveLength(1));
    transport.emitEvent({ type: 'closed', reason: 'cable removed' });
    await expect(response).rejects.toThrow(/cable removed/i);
    scheduler.dispose();
  });
});

class SchedulerTransport implements ByteTransport {
  readonly writes: string[] = [];
  discards = 0;
  readonly #byteListeners = new Set<(value: Uint8Array) => void>();
  readonly #eventListeners = new Set<(value: TransportEvent) => void>();

  async open(): Promise<void> {}
  async close(): Promise<void> {}
  async discardInput(): Promise<void> { this.discards += 1; }
  async write(value: Uint8Array): Promise<void> { this.writes.push(new TextDecoder().decode(value)); }
  onBytes(listener: (value: Uint8Array) => void): () => void { this.#byteListeners.add(listener); return () => this.#byteListeners.delete(listener); }
  onEvent(listener: (value: TransportEvent) => void): () => void { this.#eventListeners.add(listener); return () => this.#eventListeners.delete(listener); }
  emitBytes(value: Uint8Array): void { for (const listener of this.#byteListeners) listener(value); }
  emitEvent(value: TransportEvent): void { for (const listener of this.#eventListeners) listener(value); }
}
