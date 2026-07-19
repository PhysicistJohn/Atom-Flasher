import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFirmwareManifestDirectoryMemory,
  initialFirmwareManifestDirectory,
} from '../src/main/firmware-manifest-directory.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('firmware manifest native-picker directory', () => {
  it('defaults a development checkout to the sibling Atom-Firmware repository', async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), 'tinysa-flasher-picker-')));
    temporaryRoots.push(root);
    const flasher = resolve(root, 'Atom-Flasher');
    const firmware = resolve(root, 'Atom-Firmware');
    await Promise.all([mkdir(flasher), mkdir(firmware)]);

    await expect(initialFirmwareManifestDirectory(flasher)).resolves.toBe(firmware);
  });

  it('tolerates an absent sibling default without inventing a path', async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), 'tinysa-flasher-picker-')));
    temporaryRoots.push(root);
    const flasher = resolve(root, 'Atom-Flasher');
    await mkdir(flasher);

    await expect(initialFirmwareManifestDirectory(flasher)).resolves.toBeUndefined();
  });

  it('advances the picker directory only after the selected manifest is admitted', () => {
    const memory = createFirmwareManifestDirectoryMemory('/initial/Atom-Firmware');
    expect(memory.defaultPath()).toBe('/initial/Atom-Firmware');

    memory.selected('/rejected/build/manifest.json');
    memory.settled(false);
    expect(memory.defaultPath()).toBe('/initial/Atom-Firmware');

    memory.selected(undefined);
    memory.settled(false);
    expect(memory.defaultPath()).toBe('/initial/Atom-Firmware');

    memory.selected('/verified/build/manifest.json');
    memory.settled(true);
    expect(memory.defaultPath()).toBe('/verified/build');
  });
});
