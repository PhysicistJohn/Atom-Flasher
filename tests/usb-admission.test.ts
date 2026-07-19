/**
 * Pins USB device admission: only exact 0483:5740 serial candidates are
 * classified as ZS407, renderer selections must rebind to a live exact
 * enumeration, and DFU flashing admits exactly one 0483:df11 alt-0
 * internal-flash target.
 */
import { describe, expect, it } from 'vitest';
import { SerialTransport, normalizeUsbId } from '../src/device/serial-transport.js';
import { bindCurrentExactCandidate } from '../src/device/device-service.js';
import { exactOneDfuIdentity, inspectStm32DfuDevices } from '../src/dfu/dfu-util.js';
import type { PortCandidate } from '../src/core/contracts.js';
import { cdcCandidate, dfuLine } from './helpers.js';

const noPortCreation = () => { throw new Error('fixture must not open ports'); };

function transportListing(ports: Array<Record<string, string | undefined>>): SerialTransport {
  return new SerialTransport(noPortCreation, (async () => ports) as never);
}

describe('safety chain: exact CDC USB admission', () => {
  it('classifies only 0483:5740 as exact-zs407-cdc and everything else as unverified', async () => {
    const transport = transportListing([
      { path: '/dev/tty.other', vendorId: '10c4', productId: 'ea60', serialNumber: 'OTHER' },
      { path: '/dev/tty.zs407', vendorId: '0483', productId: '5740', serialNumber: 'CDC407', manufacturer: 'STMicroelectronics' },
      { path: '/dev/tty.novid' },
      { path: '/dev/tty.wrongpid', vendorId: '0483', productId: 'df11' },
    ]);

    const candidates = await transport.list();
    expect(candidates.map((candidate) => [candidate.path, candidate.usbMatch])).toEqual([
      ['/dev/tty.zs407', 'exact-zs407-cdc'],
      ['/dev/tty.novid', 'unverified-serial'],
      ['/dev/tty.other', 'unverified-serial'],
      ['/dev/tty.wrongpid', 'unverified-serial'],
    ]);
  });

  it('normalizes USB identifiers exactly and rejects malformed ones', () => {
    expect(normalizeUsbId('0x0483')).toBe('0483');
    expect(normalizeUsbId('483')).toBe('0483');
    expect(normalizeUsbId('DF11')).toBe('df11');
    expect(normalizeUsbId(undefined)).toBeUndefined();
    expect(() => normalizeUsbId('zzzz')).toThrow(/malformed USB identifier/i);
  });

  it('rebinds a selection only to a live exact 0483:5740 candidate', () => {
    expect(bindCurrentExactCandidate(cdcCandidate, [cdcCandidate])).toBe(cdcCandidate);
    expect(() => bindCurrentExactCandidate({ ...cdcCandidate, vendorId: '1234', usbMatch: 'unverified-serial' } as PortCandidate, [cdcCandidate]))
      .toThrow(/exact USB 0483:5740 admission/i);
    expect(() => bindCurrentExactCandidate(cdcCandidate, [])).toThrow(/stale or ambiguous/i);
    expect(() => bindCurrentExactCandidate(cdcCandidate, [{ ...cdcCandidate, id: 'changed', serialNumber: 'OTHER' }]))
      .toThrow(/serial no longer matches/i);
    expect(() => bindCurrentExactCandidate(cdcCandidate, [{ ...cdcCandidate, id: 'regenerated-token' }]))
      .toThrow(/token is stale/i);
  });
});

describe('safety chain: exact STM32 DFU admission', () => {
  it('admits exactly one 0483:df11 alt-0 internal-flash target', () => {
    const inspection = inspectStm32DfuDevices(dfuLine);
    expect(inspection).toMatchObject({ deviceCount: 1 });
    expect(exactOneDfuIdentity(inspection)).toMatchObject({ path: '1-1', serial: 'DFU407', alt: 0 });
  });

  it('detects nothing when no 0483:df11 device is present', () => {
    expect(exactOneDfuIdentity(inspectStm32DfuDevices(''))).toBeUndefined();
    const wrongProduct = dfuLine.replace('[0483:df11]', '[0483:5740]');
    expect(exactOneDfuIdentity(inspectStm32DfuDevices(wrongProduct))).toBeUndefined();
  });

  it('rejects multiple DFU devices', () => {
    const second = dfuLine.replace('devnum=5', 'devnum=6').replace('path="1-1"', 'path="1-2"').replace('serial="DFU407"', 'serial="DFU408"');
    expect(() => exactOneDfuIdentity(inspectStm32DfuDevices(`${dfuLine}\n${second}`)))
      .toThrow(/2 STM32 DFU devices; exactly one/i);
  });

  it('rejects a device without exactly one alt-0 internal-flash target', () => {
    const altOnly = dfuLine.replace('alt=0', 'alt=1');
    expect(() => exactOneDfuIdentity(inspectStm32DfuDevices(altOnly))).toThrow(/exposes 0 exact alt-0/i);
    expect(() => exactOneDfuIdentity(inspectStm32DfuDevices(`${dfuLine}\n${dfuLine}`))).toThrow(/exposes 2 exact alt-0/i);
    const external = dfuLine.replace('@Internal Flash  /0x08000000/128*002Kg', '@External Flash  /0x90000000/64*064Kg');
    expect(() => exactOneDfuIdentity(inspectStm32DfuDevices(external))).toThrow(/exposes 0 exact alt-0/i);
  });

  it('rejects malformed DFU identity lines instead of guessing', () => {
    expect(() => inspectStm32DfuDevices('Found DFU: [0483:df11] alt=0, name="@Internal Flash  /0x08000000/128*002Kg"'))
      .toThrow(/malformed or empty stm32 dfu identity line/i);
  });
});
