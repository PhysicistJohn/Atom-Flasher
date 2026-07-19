/**
 * Pins the RF-off-before-flash chain: `output off` is the first command on
 * connect and precedes identity reads, disconnect sends `output off` before
 * closing the transport, an unacknowledged `output off` latches a fail-closed
 * fault, and preflight disconnects (RF off) before entering awaiting-dfu.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { PortCandidate } from '../src/core/contracts.js';
import { Zs407DeviceService, type DeviceTransport } from '../src/device/device-service.js';
import type { TransportEvent } from '../src/device/protocol.js';
import { FirmwareUpdater } from '../src/core/firmware-updater.js';
import {
  FakeFirmwareDevice,
  removeTemporaryDirectories,
  runtimeFixture,
  successfulTransfer,
  temporaryDirectory,
  validPreflight,
} from './helpers.js';

afterEach(removeTemporaryDirectories);

const port: PortCandidate = { id: 'one', path: '/dev/tty.usbmodem', vendorId: '0483', productId: '5740', serialNumber: 'CDC407', usbMatch: 'exact-zs407-cdc' };

describe('safety chain: RF off before flash', () => {
  it('issues output off before any identity command on connect', async () => {
    const transport = new ScriptedTransport();
    const service = new Zs407DeviceService(transport);

    expect(await service.connect(port)).toMatchObject({ connection: 'ready', identity: { usbIdentityVerified: true } });
    expect(transport.log[0]).toBe('output off');
    expect(transport.log.indexOf('output off')).toBeLessThan(transport.log.indexOf('version'));
  });

  it('issues output off before closing the transport on disconnect', async () => {
    const transport = new ScriptedTransport();
    const service = new Zs407DeviceService(transport);
    await service.connect(port);
    transport.log.length = 0;

    await service.disconnect();
    expect(transport.log[0]).toBe('output off');
    expect(transport.log).toContain('#close');
    expect(transport.log.indexOf('output off')).toBeLessThan(transport.log.indexOf('#close'));
    expect(service.snapshot()).toEqual({ connection: 'disconnected' });
  });

  it('latches a fail-closed fault when output off is not acknowledged', async () => {
    const service = new Zs407DeviceService(new ScriptedTransport({ mutationReplies: { 'output off': 'ok' } }));

    await expect(service.connect(port)).rejects.toThrow(/mutating commands require an empty reply/i);
    expect(service.snapshot()).toMatchObject({
      connection: 'faulted',
      fault: expect.stringMatching(/power the analyzer off manually/i),
    });
  });

  it('latches an unconfirmed output-off disconnect as a manual safety fault', async () => {
    const transport = new ScriptedTransport({ failOutputOffAt: 3 });
    const service = new Zs407DeviceService(transport);
    await service.connect(port);

    await expect(service.disconnect()).rejects.toThrow(/output off remains unconfirmed/i);
    expect(service.snapshot()).toMatchObject({ connection: 'faulted', fault: expect.stringMatching(/power the analyzer off manually/i) });
  });

  it('disconnects the device (RF-off path) before entering awaiting-dfu', async () => {
    const directory = await temporaryDirectory();
    const device = new FakeFirmwareDevice();
    const updater = new FirmwareUpdater(directory, device, runtimeFixture(async () => successfulTransfer()));
    await updater.state();
    await updater.download();

    const prepared = await updater.prepare(validPreflight());

    expect(prepared.phase).toBe('awaiting-dfu');
    expect(device.snapshot()).toEqual({ connection: 'disconnected' });
  });
});

class ScriptedTransport implements DeviceTransport {
  readonly log: string[] = [];
  #bytes = new Set<(bytes: Uint8Array) => void>();
  #events = new Set<(event: TransportEvent) => void>();
  #outputOffCount = 0;

  constructor(private readonly options: {
    failOutputOffAt?: number;
    mutationReplies?: Readonly<Partial<Record<'output off' | 'mode input', string>>>;
  } = {}) {}

  async list(): Promise<PortCandidate[]> { return [port]; }
  async open(): Promise<void> { this.emit({ type: 'opened' }); }
  async close(): Promise<void> {
    this.log.push('#close');
    this.emit({ type: 'closed', reason: 'closed by test' });
  }
  async discardInput(): Promise<void> {}
  async write(bytes: Uint8Array): Promise<void> {
    const command = new TextDecoder().decode(bytes).replace(/\r$/, '');
    this.log.push(command);
    if (command === 'output off') {
      this.#outputOffCount += 1;
      if (this.#outputOffCount === this.options.failOutputOffAt) throw new Error('fixture output-off write failed');
    }
    const payload: Record<string, string> = {
      'output off': '',
      version: 'tinySA4_v1.4-217-gc5dd31f\r\nHW Version: V0.5.4 + ZS407',
      info: 'tinySA ULTRA+ ZS407',
      help: 'commands: mode output deviceid\r\nOther commands: version info help vbat capture',
      'mode input': '',
      vbat: '4211 mV',
      deviceid: 'deviceid 407',
    };
    const mutationReply = command === 'output off' || command === 'mode input'
      ? this.options.mutationReplies?.[command]
      : undefined;
    const response = mutationReply ?? payload[command];
    if (response === undefined) throw new Error(`Unexpected fixture command ${command}`);
    const frame = new TextEncoder().encode(`${command}\r\n${response}${response ? '\r\n' : ''}ch> `);
    queueMicrotask(() => { for (const listener of this.#bytes) listener(frame); });
  }
  onBytes(listener: (bytes: Uint8Array) => void): () => void { this.#bytes.add(listener); return () => this.#bytes.delete(listener); }
  onEvent(listener: (event: TransportEvent) => void): () => void { this.#events.add(listener); return () => this.#events.delete(listener); }
  emit(event: TransportEvent): void { for (const listener of this.#events) listener(event); }
}
