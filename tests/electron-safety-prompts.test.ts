import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

const { showMessageBox } = vi.hoisted(() => ({ showMessageBox: vi.fn() }));
vi.mock('electron', () => ({ dialog: { showMessageBox } }));

import { ElectronSafetyPrompts } from '../src/main/electron-safety-prompts.js';

const owner = { isDestroyed: () => false } as BrowserWindow;

beforeEach(() => { showMessageBox.mockReset(); });

describe('native Electron safety prompt adapter', () => {
  it('defaults firmware confirmation to cancel and accepts only the explicit write button', async () => {
    const prompts = new ElectronSafetyPrompts(() => owner);
    showMessageBox.mockResolvedValueOnce({ response: 0 });
    await expect(prompts.confirmFirmwareWrite({
      preparationId: '11111111-1111-4111-8111-111111111111',
      targetId: 'oem-zs407-c979386',
      targetKind: 'oem',
      targetVersion: 'tinySA4_v1.4-224-gc979386',
      targetSha256: 'a'.repeat(64),
    })).resolves.toBe(false);
    expect(showMessageBox).toHaveBeenLastCalledWith(owner, expect.objectContaining({
      defaultId: 0,
      cancelId: 0,
      buttons: ['Cancel', 'Flash verified OEM firmware'],
      detail: expect.stringContaining('11111111-1111-4111-8111-111111111111'),
    }));

    showMessageBox.mockResolvedValueOnce({ response: 1 });
    await expect(prompts.confirmFirmwareWrite({
      preparationId: '11111111-1111-4111-8111-111111111111',
      targetId: 'oem-zs407-c979386',
      targetKind: 'oem',
      targetVersion: 'tinySA4_v1.4-224-gc979386',
      targetSha256: 'a'.repeat(64),
    })).resolves.toBe(true);
  });

  it('requires a second explicit native confirmation for physical-power-off recovery', async () => {
    const prompts = new ElectronSafetyPrompts(() => owner);
    showMessageBox.mockResolvedValueOnce({ response: 1 });
    await expect(prompts.confirmPhysicalPowerOff()).resolves.toBe(true);
    expect(showMessageBox).toHaveBeenCalledWith(owner, expect.objectContaining({
      defaultId: 0,
      cancelId: 0,
      buttons: ['Cancel', 'The analyzer is physically off'],
    }));
  });

  it('labels a local custom target distinctly from the pinned OEM release', async () => {
    const prompts = new ElectronSafetyPrompts(() => owner);
    showMessageBox.mockResolvedValueOnce({ response: 1 });
    await expect(prompts.confirmFirmwareWrite({
      preparationId: '11111111-1111-4111-8111-111111111111',
      targetId: `custom-zs407-${'b'.repeat(64)}`,
      targetKind: 'local-custom',
      targetVersion: 'tinySA4_local-gabcdef0',
      targetSha256: 'b'.repeat(64),
      targetManifestSha256: 'c'.repeat(64),
    })).resolves.toBe(true);
    expect(showMessageBox).toHaveBeenCalledWith(owner, expect.objectContaining({
      title: expect.stringMatching(/local custom firmware/i),
      message: expect.stringMatching(/not an OEM release/i),
      buttons: ['Cancel', 'Flash local custom firmware'],
      detail: expect.stringContaining(`manifest SHA-256 ${'c'.repeat(64)}`),
    }));
  });

  it('fails closed when the trusted owner window is absent or destroyed', async () => {
    const missing = new ElectronSafetyPrompts(() => undefined);
    await expect(missing.confirmPhysicalPowerOff()).rejects.toThrow(/trusted application window is unavailable/i);
    const destroyed = new ElectronSafetyPrompts(() => ({ isDestroyed: () => true }) as BrowserWindow);
    await expect(destroyed.confirmFirmwareWrite({
      preparationId: 'id',
      targetId: 'target-id',
      targetKind: 'local-custom',
      targetVersion: 'target',
      targetSha256: 'a'.repeat(64),
      targetManifestSha256: 'b'.repeat(64),
    }))
      .rejects.toThrow(/trusted application window is unavailable/i);
    expect(showMessageBox).not.toHaveBeenCalled();
  });
});
