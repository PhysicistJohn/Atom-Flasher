import { describe, expect, it } from 'vitest';
import { MANUAL_POWER_OFF_CONFIRMATION, Zs407DeviceService, bindCurrentExactCandidate, parseBattery, parseDeviceId, parseHelpCommands, parseIdentity, type DeviceTransport } from '../src/device/device-service.js';
import type { PortCandidate } from '../src/core/contracts.js';
import type { TransportEvent } from '../src/device/protocol.js';

const port: PortCandidate = { id: 'one', path: '/dev/tty.usbmodem', vendorId: '0483', productId: '5740', serialNumber: 'CDC407', usbMatch: 'exact-zs407-cdc' };

describe('minimal ZS407 admission service', () => {
  it('binds exact USB evidence to a supported source revision', () => {
    const identity = parseIdentity('tinySA4_v1.4-217-gc5dd31f\r\nHW Version: V0.5.4 + ZS407', 'tinySA ULTRA+ ZS407', port);
    expect(identity).toMatchObject({ firmwareReportedRevision: 'c5dd31f', firmwareQualification: 'supported-oem', usbIdentityVerified: true });
  });

  it('labels unknown source revisions as custom and unqualified', () => {
    const identity = parseIdentity('tinySA4_custom-g43eb0f1\r\nHW Version: ZS407', 'tinySA ULTRA+ ZS407', port);
    expect(identity.firmwareQualification).toBe('custom-unqualified');
    expect(identity.firmwareWarning).toMatch(/will not flash/i);
  });

  it('does not confer OEM provenance from a recognized commit embedded in a spoofed version', () => {
    const custom = parseIdentity('tinySA4_custom-gc979386\r\nHW Version: ZS407', 'tinySA ULTRA+ ZS407', port);
    expect(custom).toMatchObject({
      firmwareVersion: 'tinySA4_custom-gc979386',
      firmwareReportedRevision: 'c979386',
      firmwareQualification: 'custom-unqualified',
    });
    expect(custom.firmwareSourceCommit).toBeUndefined();

    expect(() => parseIdentity(
      'tinySA4_v1.4-224-gc979386-dirty\r\nHW Version: ZS407',
      'tinySA ULTRA+ ZS407',
      port,
    )).toThrow(/did not report a source revision/i);
  });

  it('rejects a wrong product, malformed telemetry, and empty help', () => {
    expect(() => parseIdentity('not-a-tinysa\r\nHW Version: ZS407', 'tinySA ULTRA+ ZS407', port)).toThrow(/did not identify/);
    expect(parseBattery('4211 mV')).toBe(4211);
    expect(() => parseBattery('4.2 V')).toThrow(/Malformed battery/);
    expect(parseDeviceId('deviceid 407')).toBe(407);
    expect(() => parseDeviceId('407')).toThrow(/Malformed device ID/);
    expect(parseHelpCommands('system: version info help\r\ndevice: output capture')).toContain('capture');
    expect(() => parseHelpCommands('no catalog')).toThrow(/no command catalog/);
  });

  it('rebinds a renderer selection to the current enumerated USB identity', () => {
    expect(bindCurrentExactCandidate(port, [port])).toBe(port);
    expect(() => bindCurrentExactCandidate(port, [])).toThrow(/stale or ambiguous/);
    expect(() => bindCurrentExactCandidate(port, [{ ...port, id: 'changed', serialNumber: 'OTHER' }])).toThrow(/serial no longer matches/);
    expect(() => bindCurrentExactCandidate({ ...port, vendorId: '1234', usbMatch: 'unverified-serial' }, [port])).toThrow(/exact USB/);
  });

  it('invalidates a ready snapshot on a runtime serial error instead of leaving stale identity', async () => {
    const transport = new ScriptedTransport();
    const service = new Zs407DeviceService(transport);
    expect(await service.connect(port)).toMatchObject({ connection: 'ready', identity: { usbIdentityVerified: true } });
    transport.emit({ type: 'error', error: new Error('USB cable removed') });
    expect(service.snapshot()).toEqual({ connection: 'faulted', fault: 'USB cable removed' });
    await expect(service.disconnect()).rejects.toThrow(/output off remains unconfirmed/i);
    expect(service.snapshot()).toMatchObject({ connection: 'faulted', fault: expect.stringMatching(/power the analyzer off manually/i) });
    await expect(service.recoverAfterManualPowerOff('wrong' as never)).rejects.toThrow(/exact manual power-off/i);
    await expect(service.recoverAfterManualPowerOff(MANUAL_POWER_OFF_CONFIRMATION)).resolves.toMatchObject({ connection: 'disconnected' });
    await expect(service.connect(port)).resolves.toMatchObject({ connection: 'ready' });
  });

  it('surfaces connection cleanup failure as an aggregate fault', async () => {
    const transport = new ScriptedTransport({ version: 'not-a-tinysa\r\nHW Version: ZS407', closeFailures: 1 });
    const service = new Zs407DeviceService(transport);

    await expect(service.connect(port)).rejects.toBeInstanceOf(AggregateError);
    expect(service.snapshot()).toMatchObject({ connection: 'faulted', fault: expect.stringMatching(/cleanup also failed/i) });
  });

  it('does not overwrite a transport fault that arrives while open is completing', async () => {
    const transport = new ScriptedTransport({ faultDuringOpen: 'USB disappeared during open' });
    const service = new Zs407DeviceService(transport);

    await expect(service.connect(port)).rejects.toThrow(/USB disappeared during open/i);
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
    await expect(service.disconnect()).rejects.toThrow(/output off remains unconfirmed/i);
    expect(service.snapshot().connection).toBe('faulted');
  });
});

class ScriptedTransport implements DeviceTransport {
  #bytes = new Set<(bytes: Uint8Array) => void>();
  #events = new Set<(event: TransportEvent) => void>();
  #outputOffCount = 0;
  #closeFailures: number;

  constructor(private readonly options: { version?: string; closeFailures?: number; failOutputOffAt?: number; faultDuringOpen?: string } = {}) {
    this.#closeFailures = options.closeFailures ?? 0;
  }

  async list(): Promise<PortCandidate[]> { return [port]; }
  async open(): Promise<void> {
    this.emit({ type: 'opened' });
    if (this.options.faultDuringOpen) this.emit({ type: 'error', error: new Error(this.options.faultDuringOpen) });
  }
  async close(): Promise<void> {
    if (this.#closeFailures > 0) { this.#closeFailures -= 1; throw new Error('fixture close cleanup failed'); }
    this.emit({ type: 'closed', reason: 'closed by test' });
  }
  async discardInput(): Promise<void> {}
  async write(bytes: Uint8Array): Promise<void> {
    const command = new TextDecoder().decode(bytes).replace(/\r$/, '');
    if (command === 'output off') {
      this.#outputOffCount += 1;
      if (this.#outputOffCount === this.options.failOutputOffAt) throw new Error('fixture output-off write failed');
    }
    const payload: Record<string, string> = {
      'output off': '',
      version: this.options.version ?? 'tinySA4_v1.4-217-gc5dd31f\r\nHW Version: V0.5.4 + ZS407',
      info: 'tinySA ULTRA+ ZS407',
      help: 'system: version info help mode output vbat deviceid capture',
      'mode input': '',
      vbat: '4211 mV',
      deviceid: 'deviceid 407',
    };
    const response = payload[command];
    if (response === undefined) throw new Error(`Unexpected fixture command ${command}`);
    const frame = new TextEncoder().encode(`${command}\r\n${response}${response ? '\r\n' : ''}ch> `);
    queueMicrotask(() => { for (const listener of this.#bytes) listener(frame); });
  }
  onBytes(listener: (bytes: Uint8Array) => void): () => void { this.#bytes.add(listener); return () => this.#bytes.delete(listener); }
  onEvent(listener: (event: TransportEvent) => void): () => void { this.#events.add(listener); return () => this.#events.delete(listener); }
  emit(event: TransportEvent): void { for (const listener of this.#events) listener(event); }
}
