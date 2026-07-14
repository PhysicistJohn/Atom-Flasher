import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  exactOneDfuIdentity,
  inspectInternalFlashDescriptor,
  inspectStm32DfuDevices,
  observeDfuExecution,
  parseDfuTransferProgress,
  parseDfuUtilVersion,
  readResponseBodyBounded,
  verifyFirmwareArtifact,
} from '../src/core/firmware-updater.js';
import { OEM_ZS407_FIRMWARE_RELEASE } from '../src/core/contracts.js';

const internal = 'Found DFU: [0483:df11] ver=2200, devnum=5, cfg=1, intf=0, path="1-1", alt=0, name="@Internal Flash  /0x08000000/128*002Kg", serial="407"';
const optionBytes = 'Found DFU: [0483:df11] ver=2200, devnum=5, cfg=1, intf=0, path="1-1", alt=1, name="@Option Bytes", serial="407"';

describe('fail-closed firmware primitives', () => {
  it('accepts only dfu-util 0.11', () => {
    expect(parseDfuUtilVersion('dfu-util 0.11')).toBe('0.11');
    expect(() => parseDfuUtilVersion('dfu-util 0.10')).toThrow(/requires 0.11/);
    expect(() => parseDfuUtilVersion('dfu-util 0.11.1')).toThrow(/requires 0.11/);
    expect(() => parseDfuUtilVersion('dfu-util 0.11-custom')).toThrow(/requires 0.11/);
  });

  it('parses progress without accepting impossible percentages', () => {
    expect(parseDfuTransferProgress('\rErase [===] 16% 3000 bytes')).toEqual({ operation: 'erase', percent: 16 });
    expect(parseDfuTransferProgress('\rDownload [===] 101% 3000 bytes')).toBeUndefined();
  });

  it('requires one nonempty, fully fingerprinted internal-flash target', () => {
    const inspection = inspectStm32DfuDevices(`${internal}\n${optionBytes}`);
    expect(inspection.deviceCount).toBe(1);
    expect(exactOneDfuIdentity(inspection)).toMatchObject({ path: '1-1', devnum: '5', serial: '407', alt: 0 });
    expect(exactOneDfuIdentity(inspection)?.fingerprint).toContain('"serial":"407"');
    expect(() => inspectStm32DfuDevices(internal.replace('serial="407"', 'serial=""'))).toThrow(/empty STM32 DFU identity/i);
    const second = internal.replace('devnum=5', 'devnum=8').replace('path="1-1"', 'path="1-2"');
    expect(() => exactOneDfuIdentity(inspectStm32DfuDevices(`${internal}\n${second}`))).toThrow(/2 STM32 DFU devices/);
  });

  it('requires internal flash at 0x08000000 with capacity for the pinned image', () => {
    expect(inspectInternalFlashDescriptor('@Internal Flash  /0x08000000/128*002Kg')).toEqual({ startAddress: 0x08000000, capacityBytes: 262_144 });
    expect(() => inspectInternalFlashDescriptor('@Internal Flash  /0x08004000/128*002Kg')).toThrow(/expected 0x08000000/);
    expect(() => inspectInternalFlashDescriptor('@Internal Flash  /0x08000000/64*002Kg')).toThrow(/smaller than pinned image/);
    expect(() => inspectInternalFlashDescriptor('@Internal Flash  /0x08000000/128*002Ka')).toThrow(/not both erasable and writable/);
  });

  it('streams the response through a hard exact-size bound', async () => {
    await expect(readResponseBodyBounded(new Response(Uint8Array.of(1, 2, 3)), 3)).resolves.toEqual(Uint8Array.of(1, 2, 3));
    await expect(readResponseBodyBounded(new Response(Uint8Array.of(1, 2, 3, 4)), 3)).rejects.toThrow(/exceeds pinned 3-byte bound/);
    await expect(readResponseBodyBounded(new Response(Uint8Array.of(1, 2)), 3)).rejects.toThrow(/expected exactly 3/);
  });

  it('rejects wrong artifact length before hash and wrong hash at exact length', () => {
    expect(() => verifyFirmwareArtifact(new Uint8Array(OEM_ZS407_FIRMWARE_RELEASE.sizeBytes - 1))).toThrow(/expected 185704/);
    expect(() => verifyFirmwareArtifact(new Uint8Array(OEM_ZS407_FIRMWARE_RELEASE.sizeBytes))).toThrow(/does not match pinned/);
  });

  it('observes a dfu pipe fault through child close without killing or abandoning the child', async () => {
    const child = new FakeDfuChild();
    const observed = observeDfuExecution(child as never, '/fixture/dfu-util', ['-D', 'image.bin'], 1_000, () => undefined);
    child.stdout.emit('error', new Error('fixture pipe observation failed'));
    child.emit('close', 0, null);
    await expect(observed).rejects.toThrow(/output-observation fault.*completion is indeterminate.*fixture pipe/i);
    expect(child.killed).toBe(false);
  });
});

class FakeDfuChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
}
