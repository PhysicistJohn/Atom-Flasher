import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { SerialTransport, normalizeUsbId } from '../src/device/serial-transport.js';

describe('SerialTransport', () => {
  it('normalizes, validates, and deterministically orders enumerated USB evidence', async () => {
    const transport = new SerialTransport(
      () => new FixturePort() as never,
      (async () => [
        { path: '/dev/tty.z', vendorId: '9999', productId: '1', serialNumber: 'OTHER' },
        { path: '/dev/tty.a', vendorId: '483', productId: '0X5740', serialNumber: 'ZS407' },
      ]) as never,
    );

    await expect(transport.list()).resolves.toEqual([
      {
        id: '/dev/tty.a:ZS407:0483:5740',
        path: '/dev/tty.a',
        serialNumber: 'ZS407',
        vendorId: '0483',
        productId: '5740',
        usbMatch: 'exact-zs407-cdc',
      },
      {
        id: '/dev/tty.z:OTHER:9999:0001',
        path: '/dev/tty.z',
        serialNumber: 'OTHER',
        vendorId: '9999',
        productId: '0001',
        usbMatch: 'unverified-serial',
      },
    ]);
    expect(normalizeUsbId(undefined)).toBeUndefined();
    expect(normalizeUsbId('0x1')).toBe('0001');
    expect(() => normalizeUsbId('not-an-id')).toThrow(/malformed USB identifier/i);

    const malformed = new SerialTransport(
      () => new FixturePort() as never,
      (async () => [{ path: '/dev/tty.bad', vendorId: '12345', productId: '5740' }]) as never,
    );
    await expect(malformed.list()).rejects.toThrow(/malformed USB identifier/i);
  });

  it('owns one native port, copies inbound bytes, drains writes, flushes input, and reports lifecycle events', async () => {
    const port = new FixturePort();
    let constructedWith: unknown;
    const transport = new SerialTransport((options) => {
      constructedWith = options;
      return port as never;
    });
    const bytes: Uint8Array[] = [];
    const events: string[] = [];
    const removeBytes = transport.onBytes((value) => bytes.push(value));
    const removeEvents = transport.onEvent((event) => events.push(event.type));

    await transport.open('/dev/tty.fixture');
    expect(constructedWith).toEqual({ path: '/dev/tty.fixture', baudRate: 115_200, autoOpen: false, lock: true });
    await expect(transport.open('/dev/tty.other')).rejects.toThrow(/already open/i);

    const source = Buffer.from([1, 2, 3]);
    port.emit('data', source);
    source[0] = 9;
    expect(bytes).toEqual([Uint8Array.from([1, 2, 3])]);

    await transport.write(Uint8Array.from([4, 5]));
    await transport.discardInput();
    expect(port.writes).toEqual([Uint8Array.from([4, 5])]);
    expect(port.drainCalls).toBe(1);
    expect(port.flushCalls).toBe(1);

    port.emit('error', new Error('fixture warning'));
    await transport.close();
    expect(events).toEqual(['opened', 'error', 'closed']);
    expect(port.listenerCount('data')).toBe(0);
    await expect(transport.write(new Uint8Array())).rejects.toThrow(/not open/i);
    await expect(transport.discardInput()).rejects.toThrow(/not open/i);
    removeBytes();
    removeEvents();
  });

  it('releases a failed open, removes native listeners, and permits a fresh admission', async () => {
    const failed = new FixturePort('fail');
    const replacement = new FixturePort();
    const ports = [failed, replacement];
    const transport = new SerialTransport(() => ports.shift() as never);

    await expect(transport.open('/dev/tty.failed')).rejects.toThrow(/open failed/i);
    expect(failed.eventNames()).toEqual([]);
    await expect(transport.open('/dev/tty.replacement')).resolves.toBeUndefined();
    await transport.close();
  });

  it('rejects a port that closes before its successful open callback can establish ownership', async () => {
    const port = new FixturePort('close-before-success');
    const transport = new SerialTransport(() => port as never);
    const events: string[] = [];
    transport.onEvent((event) => events.push(event.type));

    await expect(transport.open('/dev/tty.fixture')).rejects.toThrow(/closed while opening/i);
    expect(events).toEqual(['closed']);
    expect(port.eventNames()).toEqual([]);
  });

  it('closes a handle that errors during opening and does not emit a false opened event', async () => {
    const port = new FixturePort('error-before-success');
    const transport = new SerialTransport(() => port as never);
    const events: string[] = [];
    transport.onEvent((event) => events.push(event.type));

    await expect(transport.open('/dev/tty.fixture')).rejects.toThrow(/errored while opening/i);
    expect(port.closeCalls).toBe(1);
    expect(events).toEqual(['error', 'closed']);
    expect(port.eventNames()).toEqual([]);
  });

  it('retains ownership when opening cleanup cannot close so a later close can retry', async () => {
    const port = new FixturePort('error-before-success');
    port.closeFailures = 1;
    const transport = new SerialTransport(() => port as never);

    await expect(transport.open('/dev/tty.fixture')).rejects.toBeInstanceOf(AggregateError);
    await expect(transport.open('/dev/tty.other')).rejects.toThrow(/already open/i);
    await expect(transport.close()).resolves.toBeUndefined();
  });

  it('retains a port after a close callback error so a later close can retry it', async () => {
    const port = new FixturePort();
    port.closeFailures = 1;
    const transport = new SerialTransport(() => port as never);

    await transport.open('/dev/tty.fixture');
    await expect(transport.close()).rejects.toThrow(/close failed/i);
    await expect(transport.open('/dev/tty.other')).rejects.toThrow(/already open/i);
    await expect(transport.close()).resolves.toBeUndefined();
  });

  it('releases an already-closed handle and propagates write, drain, and flush callback failures', async () => {
    const first = new FixturePort();
    const second = new FixturePort();
    const ports = [first, second];
    const transport = new SerialTransport(() => ports.shift() as never);
    await transport.open('/dev/tty.first');

    first.writeFailure = new Error('write callback failed');
    await expect(transport.write(Uint8Array.of(1))).rejects.toThrow(/write callback failed/i);
    first.writeFailure = undefined;
    first.drainFailure = new Error('drain callback failed');
    await expect(transport.write(Uint8Array.of(2))).rejects.toThrow(/drain callback failed/i);
    first.drainFailure = undefined;
    first.flushFailure = new Error('flush callback failed');
    await expect(transport.discardInput()).rejects.toThrow(/flush callback failed/i);

    first.isOpen = false;
    await transport.close();
    expect(first.eventNames()).toEqual([]);
    await expect(transport.open('/dev/tty.second')).resolves.toBeUndefined();
    await transport.close();
  });
});

type OpenMode = 'normal' | 'fail' | 'close-before-success' | 'error-before-success';

class FixturePort extends EventEmitter {
  isOpen = false;
  closeFailures = 0;
  closeCalls = 0;
  drainCalls = 0;
  flushCalls = 0;
  writes: Uint8Array[] = [];
  writeFailure: Error | undefined;
  drainFailure: Error | undefined;
  flushFailure: Error | undefined;

  constructor(private readonly openMode: OpenMode = 'normal') { super(); }

  open(callback: (error: Error | null) => void): void {
    if (this.openMode === 'fail') { callback(new Error('fixture open failed')); return; }
    this.isOpen = true;
    if (this.openMode === 'close-before-success') {
      this.isOpen = false;
      this.emit('close');
    } else if (this.openMode === 'error-before-success') {
      this.emit('error', new Error('fixture errored while opening'));
    }
    callback(null);
  }

  close(callback: (error: Error | null) => void): void {
    this.closeCalls += 1;
    if (this.closeFailures > 0) {
      this.closeFailures -= 1;
      callback(new Error('fixture close failed'));
      return;
    }
    this.isOpen = false;
    this.emit('close');
    callback(null);
  }

  write(bytes: Uint8Array, callback: (error: Error | null) => void): void {
    this.writes.push(Uint8Array.from(bytes));
    callback(this.writeFailure ?? null);
  }

  drain(callback: (error: Error | null) => void): void {
    this.drainCalls += 1;
    callback(this.drainFailure ?? null);
  }

  flush(callback: (error: Error | null) => void): void {
    this.flushCalls += 1;
    callback(this.flushFailure ?? null);
  }
}
