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
  const candidate = resolve(currentWorkingDirectory, '..', 'Atom-Firmware');
  try {
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      return undefined;
    }
    return await realpath(candidate);
  } catch {
    // A picker convenience must never become a firmware-updater startup
    // dependency. Native selection and manifest admission remain available.
    return undefined;
  }
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
