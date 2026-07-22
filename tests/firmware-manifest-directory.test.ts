import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initialFirmwareManifestDirectory } from '../src/main/firmware-manifest-directory.js';

const temporaryRoots: string[] = [];

async function layout() {
  const root = await mkdtemp(join(tmpdir(), 'atomos-flasher-picker-'));
  temporaryRoots.push(root);
  const flasher = join(root, 'Atom-Flasher');
  await mkdir(flasher);
  return { root, flasher };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('initial firmware manifest directory', () => {
  it('prefers the current Atom-Firmware sibling', async () => {
    const { root, flasher } = await layout();
    const current = join(root, 'Atom-Firmware');
    await mkdir(current);
    await mkdir(join(root, 'TinySA_Firmware'));

    await expect(initialFirmwareManifestDirectory(flasher)).resolves.toBe(await realpath(current));
  });

  it('falls back to the historical sibling name for compatible workspaces', async () => {
    const { root, flasher } = await layout();
    const historical = join(root, 'TinySA_Firmware');
    await mkdir(historical);

    await expect(initialFirmwareManifestDirectory(flasher)).resolves.toBe(await realpath(historical));
  });

  it('does not follow a sibling symlink', async () => {
    const { root, flasher } = await layout();
    const target = join(root, 'elsewhere');
    await mkdir(target);
    await symlink(target, join(root, 'Atom-Firmware'));

    await expect(initialFirmwareManifestDirectory(flasher)).resolves.toBeUndefined();
  });
});
