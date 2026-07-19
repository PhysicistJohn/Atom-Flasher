/**
 * Pins the write-started journal boundary: write intent is durably journaled
 * (write lock + write-started state) before any dfu-util write process is
 * spawned, a failure before admission leaves the write not-started, and once
 * a write attempt began no second flash is ever issued.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FirmwareUpdater } from '../src/core/firmware-updater.js';
import {
  FakeFirmwareDevice,
  dfuLine,
  present,
  readyFixture,
  removeTemporaryDirectories,
  successfulTransfer,
} from './helpers.js';

afterEach(removeTemporaryDirectories);

describe('safety chain: journal before write', () => {
  it('persists the write lock and started journal before spawning dfu-util', async () => {
    let directory = '';
    let journalBeforeSpawn: unknown;
    let lockBeforeSpawn = false;
    const fixture = await readyFixture(new FakeFirmwareDevice(), async () => {
      journalBeforeSpawn = JSON.parse(await readFile(join(directory, 'firmware-update-journal-v2.json'), 'utf8'));
      lockBeforeSpawn = await present(join(directory, 'firmware-write.lock'));
      return successfulTransfer();
    });
    directory = fixture.directory;

    const completed = await fixture.updater.flash({ preparationId: fixture.preparationId, confirmation: 'FLASH VERIFIED OEM FIRMWARE' });

    expect(lockBeforeSpawn).toBe(true);
    expect(journalBeforeSpawn).toMatchObject({
      state: { phase: 'flashing', writeDisposition: 'started', writeStartedAt: expect.any(String) },
    });
    expect(completed).toMatchObject({ phase: 'completed', writeDisposition: 'completed' });
  });

  it('leaves the write not-started when the flash fails before admission', async () => {
    let spawned = false;
    let dfuVanished = false;
    const fixture = await readyFixture(
      new FakeFirmwareDevice(),
      async () => { spawned = true; return successfulTransfer(); },
      {
        runExecutable: async (_file, args) => {
          if (args.includes('--version')) return { stdout: 'dfu-util 0.11', stderr: '' };
          return { stdout: dfuVanished ? '' : dfuLine, stderr: '' };
        },
      },
    );
    dfuVanished = true;

    await expect(fixture.updater.flash({ preparationId: fixture.preparationId, confirmation: 'FLASH VERIFIED OEM FIRMWARE' }))
      .rejects.toThrow(/failed before any write attempt began.*no write was attempted/i);

    expect(spawned).toBe(false);
    expect(fixture.updater.snapshot()).toMatchObject({ phase: 'failed', writeDisposition: 'not-started' });
    expect(await present(join(fixture.directory, 'firmware-write.lock'))).toBe(false);
  });

  it('never issues a second write after a write attempt began', async () => {
    const fixture = await readyFixture(new FakeFirmwareDevice(), async () => {
      throw new Error('dfu-util exited with code 74: transfer failed');
    });

    await expect(fixture.updater.flash({ preparationId: fixture.preparationId, confirmation: 'FLASH VERIFIED OEM FIRMWARE' }))
      .rejects.toThrow(/do not flash again/i);
    expect(fixture.updater.snapshot()).toMatchObject({ phase: 'failed', writeDisposition: 'started' });
    expect(await present(join(fixture.directory, 'firmware-write.lock'))).toBe(true);
    expect(JSON.parse(await readFile(join(fixture.directory, 'firmware-update-journal-v2.json'), 'utf8')))
      .toMatchObject({ state: { phase: 'failed', writeDisposition: 'started' } });

    await expect(fixture.updater.flash({ preparationId: fixture.preparationId, confirmation: 'FLASH VERIFIED OEM FIRMWARE' }))
      .rejects.toThrow(/write attempt already began/i);

    const recovered = new FirmwareUpdater(fixture.directory, new FakeFirmwareDevice({ disconnected: true }), fixture.runtime);
    expect(await recovered.state()).toMatchObject({ phase: 'failed', writeDisposition: 'started' });
    await expect(recovered.detectDfu()).rejects.toThrow(/write attempt already began/i);
    await expect(recovered.flash({ preparationId: fixture.preparationId, confirmation: 'FLASH VERIFIED OEM FIRMWARE' }))
      .rejects.toThrow(/write attempt already began/i);
  });
});
