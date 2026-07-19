/**
 * One full mocked-device flash flow: available -> download -> prepare ->
 * detect-dfu -> flash -> completed, pinning the exact dfu-util argv, the
 * inherited verified descriptor, and the completed-ledger archive.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OEM_ZS407_FIRMWARE_RELEASE } from '../src/core/contracts.js';
import { FirmwareUpdater } from '../src/core/firmware-updater.js';
import { inspectFirmwareSafetyEvidence } from '../src/core/legacy-migration.js';
import {
  FakeFirmwareDevice,
  present,
  removeTemporaryDirectories,
  runtimeFixture,
  successfulTransfer,
  temporaryDirectory,
  validPreflight,
} from './helpers.js';

afterEach(removeTemporaryDirectories);

describe('happy-path flash flow', () => {
  it('walks available -> download -> prepare -> detect-dfu -> flash -> completed', async () => {
    const directory = await temporaryDirectory();
    let observedArgs: readonly string[] = [];
    let inheritedDescriptor: number | undefined;
    const device = new FakeFirmwareDevice();
    const updater = new FirmwareUpdater(directory, device, runtimeFixture(async (_file, args, _duration, onProgress, firmware) => {
      observedArgs = args;
      inheritedDescriptor = firmware.descriptor;
      onProgress({ operation: 'erase', percent: 100 });
      onProgress({ operation: 'download', percent: 100 });
      return successfulTransfer();
    }));

    expect(await updater.state()).toMatchObject({
      phase: 'available', target: { kind: 'oem' }, updateAvailable: true, writeIntent: 'update-oem',
    });
    expect(await updater.download()).toMatchObject({
      phase: 'verified',
      artifact: { sha256: OEM_ZS407_FIRMWARE_RELEASE.sha256, sizeBytes: OEM_ZS407_FIRMWARE_RELEASE.sizeBytes },
    });
    const prepared = await updater.prepare(validPreflight());
    expect(prepared).toMatchObject({ phase: 'awaiting-dfu', preparation: { id: expect.any(String) } });
    expect(await updater.detectDfu()).toMatchObject({
      phase: 'ready-to-flash',
      dfuDevice: { detected: true, count: 1, identity: { path: '1-1', serial: 'DFU407' } },
    });

    const completed = await updater.flash({ preparationId: prepared.preparation!.id, confirmation: 'FLASH VERIFIED OEM FIRMWARE' });

    expect(observedArgs).toEqual([
      '-d', '0483:df11', '-p', '1-1', '-S', 'DFU407', '-a', '0', '-s', '0x08000000:leave',
    ]);
    expect(inheritedDescriptor).toEqual(expect.any(Number));
    expect(inheritedDescriptor).toBeGreaterThan(2);
    expect(completed).toMatchObject({
      phase: 'completed',
      writeDisposition: 'completed',
      updateAvailable: false,
      current: { version: OEM_ZS407_FIRMWARE_RELEASE.version, revision: OEM_ZS407_FIRMWARE_RELEASE.revision, qualification: 'supported-oem' },
      flashProgress: { stage: 'complete', percent: 100 },
    });

    expect(await present(join(directory, 'firmware-write.lock'))).toBe(false);
    expect(await present(join(directory, 'firmware-update-journal-v2.json'))).toBe(false);
    const ledger = await readdir(join(directory, 'completed-ledger-v2'));
    expect(ledger).toEqual([`device-407-preparation-${prepared.preparation!.id}.json`]);
    expect(JSON.parse(await readFile(join(directory, 'completed-ledger-v2', ledger[0]!), 'utf8')))
      .toMatchObject({ state: { phase: 'completed', completedAt: expect.any(String) } });
    expect(await inspectFirmwareSafetyEvidence(directory)).toEqual([]);
  });
});
