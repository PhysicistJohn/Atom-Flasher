import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

/**
 * Selects only a native-picker starting directory. This path never crosses
 * renderer IPC and grants no firmware authority; normal manifest admission
 * still reopens and validates the operator-selected file.
 */
export async function initialFirmwareManifestDirectory(
  currentWorkingDirectory: string,
): Promise<string | undefined> {
  for (const repositoryName of ['Atom-Firmware', 'TinySA_Firmware']) {
    const candidate = resolve(currentWorkingDirectory, '..', repositoryName);
    try {
      const metadata = await lstat(candidate);
      if (!metadata.isSymbolicLink() && metadata.isDirectory()) {
        return await realpath(candidate);
      }
    } catch {
      // Continue to the historical sibling name. Picker convenience must not
      // become an updater startup dependency.
    }
  }
  return undefined;
}

/** Remembers only a directory whose selected manifest completed admission. */
export function createFirmwareManifestDirectoryMemory(initialDirectory?: string) {
  let verifiedDirectory = initialDirectory;
  let pendingSelection: string | undefined;
  return Object.freeze({
    defaultPath: (): string | undefined => verifiedDirectory,
    selected: (path: string | undefined): void => {
      if (path !== undefined && (!isAbsolute(path) || path.includes('\0'))) {
        pendingSelection = undefined;
        throw new Error('Native firmware manifest selection must be an absolute path');
      }
      pendingSelection = path;
    },
    settled: (admitted: boolean): void => {
      if (admitted && pendingSelection) verifiedDirectory = dirname(pendingSelection);
      pendingSelection = undefined;
    },
  });
}
