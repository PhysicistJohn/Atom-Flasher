import { afterEach, describe, expect, it } from 'vitest';
import { MINIMUM_UPDATE_BATTERY_MV } from '../src/core/contracts.js';
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

async function downloadedUpdater(batteryMillivolts: number): Promise<FirmwareUpdater> {
  const updater = new FirmwareUpdater(
    await temporaryDirectory(),
    new FakeFirmwareDevice({ batteryMillivolts }),
    runtimeFixture(async () => successfulTransfer()),
  );
  await updater.state();
  await updater.download();
  return updater;
}

describe('firmware preflight battery boundary', () => {
  it.each([3_950, MINIMUM_UPDATE_BATTERY_MV])(
    'admits a %d mV battery reading',
    async (batteryMillivolts) => {
      const updater = await downloadedUpdater(batteryMillivolts);

      await expect(updater.prepare(validPreflight())).resolves.toMatchObject({
        phase: 'awaiting-dfu',
        preparation: { batteryMillivolts },
      });
    },
  );

  it('continues to fail closed below 3.9 V', async () => {
    const batteryMillivolts = MINIMUM_UPDATE_BATTERY_MV - 1;
    const updater = await downloadedUpdater(batteryMillivolts);

    await expect(updater.prepare(validPreflight())).rejects.toThrow(
      `Battery is ${batteryMillivolts} mV; firmware update requires at least ${MINIMUM_UPDATE_BATTERY_MV} mV`,
    );
  });
});
