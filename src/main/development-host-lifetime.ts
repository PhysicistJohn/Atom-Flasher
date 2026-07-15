import { createReadStream, fstatSync } from 'node:fs';
import type { Readable } from 'node:stream';

export const DEVELOPMENT_HOST_LIFETIME_FD_ENV = 'TINYSA_FLASHER_DEV_HOST_LIFETIME_FD' as const;

type DevelopmentHostLifetimeStreamFactory = (descriptor: number) => Readable;

/**
 * Returns the inherited lifetime descriptor required by a hardware-capable
 * development renderer. Packaged/file renderers deliberately ignore this
 * development-only environment input.
 */
export function developmentHostLifetimeDescriptor(
  environment: NodeJS.ProcessEnv,
  isPackaged: boolean,
  hasDevelopmentRenderer: boolean,
): number | undefined {
  if (isPackaged || !hasDevelopmentRenderer) return undefined;
  const raw = environment[DEVELOPMENT_HOST_LIFETIME_FD_ENV];
  if (!raw || !/^\d+$/.test(raw)) {
    throw new Error(`${DEVELOPMENT_HOST_LIFETIME_FD_ENV} must name an inherited non-stdio descriptor`);
  }
  const descriptor = Number(raw);
  if (!Number.isSafeInteger(descriptor) || descriptor < 3 || descriptor > 255) {
    throw new Error(`${DEVELOPMENT_HOST_LIFETIME_FD_ENV} must be an integer from 3 through 255`);
  }
  return descriptor;
}

/**
 * Irreversible authority for the live development renderer. The development
 * host owns the other end of an inherited pipe. Normal exit, an unhandled
 * failure, SIGKILL, or terminal loss closes that endpoint in the kernel; EOF
 * permanently revokes renderer authority in Electron.
 */
export class DevelopmentHostLifetime {
  readonly #stream: Readable;
  readonly #onLost: (reason: string) => void;
  #available = true;
  #disposed = false;

  constructor(
    descriptor: number,
    onLost: (reason: string) => void,
    openStream: DevelopmentHostLifetimeStreamFactory = openInheritedLifetimeStream,
  ) {
    if (!Number.isSafeInteger(descriptor) || descriptor < 3 || descriptor > 255) {
      throw new Error('Development-host lifetime descriptor must be an integer from 3 through 255');
    }
    this.#onLost = onLost;
    this.#stream = openStream(descriptor);
    this.#stream.once('end', () => this.#lose('Development host lifetime channel reached EOF'));
    this.#stream.once('close', () => this.#lose('Development host lifetime channel closed'));
    this.#stream.once('error', (value) => this.#lose(`Development host lifetime channel failed: ${message(value)}`));
    this.#stream.once('data', () => this.#lose('Development host lifetime channel carried unexpected data'));
    // No payload is legal. Flowing mode is required so kernel EOF is observed
    // even while the renderer and main process are otherwise idle.
    this.#stream.resume();
  }

  get available(): boolean { return this.#available && !this.#disposed; }

  assertAvailable(): void {
    if (!this.available) throw new Error('The development host lifetime ended; renderer authority is permanently quarantined');
  }

  /** Normal application shutdown closes the local descriptor without firing quarantine. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#available = false;
    this.#stream.removeAllListeners();
    this.#stream.destroy();
  }

  #lose(reason: string): void {
    if (this.#disposed || !this.#available) return;
    this.#available = false;
    try { this.#stream.destroy(); } catch { /* Authority is already revoked. */ }
    try { this.#onLost(reason); }
    catch (value) {
      // Authority is already irreversibly false. A UI-adapter cleanup failure
      // must not terminate a main-process firmware write that is already in
      // flight; every later IPC trust check still fails closed.
      console.error('Development renderer quarantine cleanup failed after authority revocation', value);
    }
  }
}

function openInheritedLifetimeStream(descriptor: number): Readable {
  const metadata = fstatSync(descriptor);
  if (!metadata.isFIFO() && !metadata.isSocket()) {
    throw new Error('Development-host lifetime descriptor is not an inherited pipe or socket');
  }
  return createReadStream('', { fd: descriptor, autoClose: true });
}

function message(value: unknown): string {
  try { return value instanceof Error ? value.message : String(value); }
  catch { return 'unprintable error'; }
}
