// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { installSafeRendererMock } from '../src/renderer/dev-mock.js';

afterEach(() => {
  document.body.replaceChildren();
  Reflect.deleteProperty(window, 'tinySaFlasher');
});

describe('safe renderer development mock', () => {
  it('exercises the pre-write UI workflow without exposing a write capability', async () => {
    installSafeRendererMock();
    expect(document.body.textContent).toContain('NO ELECTRON, SERIAL, NETWORK, FILESYSTEM, OR DFU ACCESS');
    const scanned = await window.tinySaFlasher.scanDevices();
    const exact = scanned.snapshot.discovery.candidates.find((candidate) => candidate.usbMatch === 'exact-zs407-cdc');
    expect(exact?.path).toBe('/dev/mock.tinySA-ZS407');
    if (!exact) throw new Error('Safe mock exact candidate is missing');

    expect((await window.tinySaFlasher.connectDevice(exact)).snapshot.device.connection).toBe('ready');
    expect((await window.tinySaFlasher.snapshot()).update.phase).toBe('available');
    expect((await window.tinySaFlasher.download()).snapshot.update.phase).toBe('verified');
    expect((await window.tinySaFlasher.prepare({
      selfTestPassed: true,
      selfTestProcedure: 'tinySA4-zs407-cal-rf-v1',
      configurationDisposition: 'new-device-unchanged',
      rfPortsDisconnected: true,
      onlyUsbDeviceConnected: true,
    })).snapshot.update.phase).toBe('awaiting-dfu');
    const ready = await window.tinySaFlasher.detectDfu();
    expect(ready.snapshot.update.phase).toBe('ready-to-flash');
    expect((await window.tinySaFlasher.flash(ready.snapshot.update.preparation?.id ?? '')).outcome).toBe('cancelled');
    expect((await window.tinySaFlasher.snapshot()).update.writeDisposition).toBe('not-started');
  });

  it('retains the same strict request boundary as the production preload', async () => {
    installSafeRendererMock();
    await expect(window.tinySaFlasher.prepare({} as never)).rejects.toThrow();
    await expect(window.tinySaFlasher.flash('not-a-uuid')).rejects.toThrow();
  });
});
