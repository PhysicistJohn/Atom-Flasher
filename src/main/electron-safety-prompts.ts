import { dialog, type BrowserWindow } from 'electron';
import type { FirmwareWritePrompt, NativeSafetyPromptPort } from '../application/flasher-application.js';

export class ElectronSafetyPrompts implements NativeSafetyPromptPort {
  constructor(private readonly getWindow: () => BrowserWindow | undefined) {}

  async confirmFirmwareWrite(input: FirmwareWritePrompt): Promise<boolean> {
    const owner = this.#requireWindow();
    const custom = input.targetKind === 'local-custom';
    const manifestBinding = custom ? `, manifest SHA-256 ${input.targetManifestSha256}` : '';
    const confirmation = await dialog.showMessageBox(owner, {
      type: 'warning',
      title: custom ? 'Write local custom firmware to internal flash?' : 'Write OEM firmware to internal flash?',
      message: custom
        ? 'This target is a locally imported custom build, not an OEM release.'
        : 'This is the only action that writes the tinySA internal flash.',
      detail: `Flasher will write only ${input.targetVersion} (${input.targetId}, image SHA-256 ${input.targetSha256}${manifestBinding}) for preparation ${input.preparationId}. Keep USB and power connected until post-reboot identity verification completes.`,
      buttons: ['Cancel', custom ? 'Flash local custom firmware' : 'Flash verified OEM firmware'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return confirmation.response === 1;
  }

  async confirmPhysicalPowerOff(): Promise<boolean> {
    const owner = this.#requireWindow();
    const confirmation = await dialog.showMessageBox(owner, {
      type: 'warning',
      title: 'Confirm physical power-off',
      message: 'Power the analyzer off before clearing this serial safety fault.',
      detail: 'Flasher could not confirm RF output off. Continue only after the physical power switch is off. A later connection repeats exact USB and RF-off admission from the beginning.',
      buttons: ['Cancel', 'The analyzer is physically off'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return confirmation.response === 1;
  }

  #requireWindow(): BrowserWindow {
    const owner = this.getWindow();
    if (!owner || owner.isDestroyed()) throw new Error('The trusted application window is unavailable');
    return owner;
  }
}
