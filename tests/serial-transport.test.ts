import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { SerialTransport } from '../src/device/serial-transport.js';

describe('SerialTransport close ownership', () => {
  it('retains a port after a close callback error so a later close can retry it', async () => {
    const port = new RetryClosePort();
    const transport = new SerialTransport(() => port as never);

    await transport.open('/dev/tty.fixture');
    await expect(transport.close()).rejects.toThrow(/close failed once/i);
    await expect(transport.open('/dev/tty.other')).rejects.toThrow(/already open/i);

    await expect(transport.close()).resolves.toBeUndefined();
    await expect(transport.open('/dev/tty.fixture')).resolves.toBeUndefined();
  });
});

class RetryClosePort extends EventEmitter {
  isOpen = false;
  #closeAttempts = 0;

  open(callback: (error: Error | null) => void): void {
    this.isOpen = true;
    callback(null);
  }

  close(callback: (error: Error | null) => void): void {
    this.#closeAttempts += 1;
    if (this.#closeAttempts === 1) {
      callback(new Error('close failed once'));
      return;
    }
    this.isOpen = false;
    this.emit('close');
    callback(null);
  }

  write(_bytes: Uint8Array, callback: (error: Error | null) => void): void { callback(null); }
  drain(callback: (error: Error | null) => void): void { callback(null); }
}
