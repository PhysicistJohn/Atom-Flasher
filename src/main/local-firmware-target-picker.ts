import type { BrowserWindow } from 'electron';
import {
  LocalFirmwareBuildStore,
  localCustomTargetForBuild,
  type ImportedLocalFirmwareBuild,
} from '../core/local-firmware-build.js';
import type { LocalCustomFirmwareTarget } from '../core/contracts.js';
import type { AdmittedFirmwareArtifact } from '../core/firmware-updater.js';
import type {
  LocalFirmwareTargetPickerPort,
  LocalFirmwareTargetSelection,
} from '../application/flasher-application.js';

export interface LocalFirmwareManifestDialog {
  chooseManifest(parent: BrowserWindow | undefined): Promise<string | undefined>;
}

/**
 * Main-process-only adapter. Renderer input can request the picker, but no
 * renderer-controlled filesystem path can cross this boundary.
 */
export class LocalFirmwareTargetPicker implements LocalFirmwareTargetPickerPort {
  constructor(
    private readonly parentWindow: () => BrowserWindow | undefined,
    private readonly dialog: LocalFirmwareManifestDialog,
    private readonly store: LocalFirmwareBuildStore,
  ) {}

  async selectLocalFirmwareTarget(): Promise<LocalFirmwareTargetSelection | undefined> {
    try {
      const selectedPath = await this.dialog.chooseManifest(this.parentWindow());
      if (!selectedPath) return undefined;
      const imported = await this.store.importManifest(selectedPath);
      return selectionFor(this.store, imported);
    } catch (cause) {
      throw new Error('The selected local firmware build could not be admitted; verify its manifest, adjacent binary, ownership, permissions, and digests', { cause });
    }
  }

  async reopenLocalFirmwareTarget(target: LocalCustomFirmwareTarget): Promise<LocalFirmwareTargetSelection> {
    return selectionFor(this.store, await this.store.reopenTarget(target));
  }
}

function selectionFor(store: LocalFirmwareBuildStore, imported: ImportedLocalFirmwareBuild): LocalFirmwareTargetSelection {
  const target = localCustomTargetForBuild(imported);
  return Object.freeze({ target, artifact: admittedArtifact(store, imported, target) });
}

function admittedArtifact(
  store: LocalFirmwareBuildStore,
  imported: ImportedLocalFirmwareBuild,
  target: LocalCustomFirmwareTarget,
): AdmittedFirmwareArtifact {
  return Object.freeze({
    targetId: target.targetId,
    openVerified: async () => {
      try { return await store.openVerified(imported); }
      catch (cause) {
        throw new Error('The app-owned local firmware build could not be reopened and verified', { cause });
      }
    },
  });
}
