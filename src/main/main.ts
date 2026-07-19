import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BrowserWindow,
  app,
  dialog,
  ipcMain,
  shell,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type WebPreferences,
} from 'electron';
import { FlasherApplication } from '../application/flasher-application.js';
import { FirmwareUpdater, locateDfuUtility } from '../core/firmware-updater.js';
import { LocalFirmwareBuildStore } from '../core/local-firmware-build.js';
import { migrateLegacyFirmwareState } from '../core/legacy-migration.js';
import { Zs407DeviceService } from '../device/device-service.js';
import { loadApplicationConfig, type ApplicationConfig } from './config.js';
import {
  DevelopmentHostLifetime,
  developmentHostLifetimeDescriptor,
} from './development-host-lifetime.js';
import { ElectronSafetyPrompts } from './electron-safety-prompts.js';
import {
  createFirmwareManifestDirectoryMemory,
  initialFirmwareManifestDirectory,
} from './firmware-manifest-directory.js';
import { registerApplicationIpc } from './ipc-handlers.js';
import { LocalFirmwareTargetPicker } from './local-firmware-target-picker.js';
import { isTrustedRendererUrl, type RendererTrust } from './security.js';

app.setName('Flasher');
const isolatedDeveloperData = !app.isPackaged && process.env.TINYSA_FLASHER_DEV_USER_DATA
  ? process.env.TINYSA_FLASHER_DEV_USER_DATA
  : undefined;
if (isolatedDeveloperData) app.setPath('userData', isolatedDeveloperData);

const runtimeSmoke = app.isPackaged && process.env.TINYSA_FLASHER_RUNTIME_SMOKE === '1';
const singleInstance = runtimeSmoke || app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

class DesktopHost {
  #window: BrowserWindow | undefined;
  #trustedRenderer: RendererTrust | undefined;
  #config: ApplicationConfig | undefined;
  #application: FlasherApplication | undefined;
  #removeIpc: (() => void) | undefined;
  #allowWindowDestruction = false;
  #quitApproved = false;
  #shutdownInFlight = false;
  #windowReleaseInFlight = false;
  #developmentHostLifetime: DevelopmentHostLifetime | undefined;
  #developmentRendererQuarantined = false;

  installLifecycle(): void {
    app.on('second-instance', () => {
      const window = this.#liveWindow();
      if (!window) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    });
    app.on('before-quit', (event) => {
      if (this.#quitApproved) return;
      event.preventDefault();
      void this.#requestSafeQuit();
    });
    app.on('activate', () => {
      if (!this.#developmentRendererQuarantined && !this.#liveWindow() && this.#config && this.#application) {
        this.#window = this.#createWindow(this.#config);
        this.#application.resumeAfterWindowOpen();
      }
    });
    app.on('window-all-closed', () => {
      if (!this.#developmentRendererQuarantined && process.platform !== 'darwin') app.quit();
    });
  }

  async start(): Promise<void> {
    const config = loadApplicationConfig(process.env, app.isPackaged);
    this.#config = config;
    const lifetimeDescriptor = developmentHostLifetimeDescriptor(
      process.env,
      app.isPackaged,
      Boolean(config.developmentServerUrl),
    );
    if (lifetimeDescriptor !== undefined) {
      this.#developmentHostLifetime = new DevelopmentHostLifetime(
        lifetimeDescriptor,
        (reason) => this.#quarantineDevelopmentRenderer(reason),
      );
    }
    const userData = app.getPath('userData');
    const applicationData = app.getPath('appData');
    if (!isolatedDeveloperData) {
      await migrateLegacyFirmwareState(join(userData, 'firmware'), [
        join(applicationData, 'Flasher', 'firmware'),
        join(applicationData, 'TinySA Atomizer', 'firmware'),
        join(applicationData, 'TinySA Atomizer Dev', 'firmware'),
      ]);
    }

    const firmwareDirectory = join(userData, 'firmware');
    const device = new Zs407DeviceService();
    const updater = new FirmwareUpdater(firmwareDirectory, device, {
      locateDfuUtility: () => locateDfuUtility(config.dfuUtilPath, config.executableSearchPath),
    });
    const prompts = new ElectronSafetyPrompts(() => this.#liveWindow());
    const localBuildStore = new LocalFirmwareBuildStore(firmwareDirectory);
    const manifestDirectory = createFirmwareManifestDirectoryMemory(
      await initialFirmwareManifestDirectory(process.cwd()),
    );
    const nativeTargetPicker = new LocalFirmwareTargetPicker(
      () => this.#liveWindow(),
      {
        chooseManifest: async (parent) => {
          const defaultPath = manifestDirectory.defaultPath();
          const options: OpenDialogOptions = {
            title: 'Select a Atom-Firmware build manifest',
            buttonLabel: 'Verify build manifest',
            ...(defaultPath ? { defaultPath } : {}),
            properties: ['openFile', 'dontAddToRecent'],
            filters: [{ name: 'TinySA firmware build manifest', extensions: ['json'] }],
          };
          const selected = parent
            ? await dialog.showOpenDialog(parent, options)
            : await dialog.showOpenDialog(options);
          const selectedPath = selected.canceled || selected.filePaths.length !== 1 ? undefined : selected.filePaths[0];
          manifestDirectory.selected(selectedPath);
          return selectedPath;
        },
      },
      localBuildStore,
    );
    const targetPicker = {
      selectLocalFirmwareTarget: async () => {
        try {
          const selection = await nativeTargetPicker.selectLocalFirmwareTarget();
          manifestDirectory.settled(selection !== undefined);
          return selection;
        } catch (cause) {
          manifestDirectory.settled(false);
          throw cause;
        }
      },
      reopenLocalFirmwareTarget: (target: Parameters<LocalFirmwareTargetPicker['reopenLocalFirmwareTarget']>[0]) => (
        nativeTargetPicker.reopenLocalFirmwareTarget(target)
      ),
    };
    const recovered = await updater.state();
    if (recovered.target.kind === 'local-custom'
      && recovered.preparation
      && recovered.writeDisposition === 'not-started') {
      try {
        const selection = await targetPicker.reopenLocalFirmwareTarget(recovered.target);
        await updater.admitLocalCustomTarget(selection.target, selection.artifact);
      } catch (value) {
        // The application remains available so the operator can re-select the
        // exact manifest. No DFU write is possible without re-admission.
        console.warn('Prepared custom artifact requires operator re-admission', value);
      }
    }
    const application = new FlasherApplication(device, updater, prompts, targetPicker);
    await application.initialize();
    this.#application = application;
    this.#assertRendererAuthority();
    this.#removeIpc = registerApplicationIpc<IpcMainInvokeEvent>({
      application,
      registrar: {
        handle: (channel, listener) => ipcMain.handle(channel, (event, ...args) => listener(event, ...args)),
        removeHandler: (channel) => ipcMain.removeHandler(channel),
      },
      isTrusted: (event) => this.#isTrustedEvent(event),
    });
    this.#window = this.#createWindow(config);
  }

  #createWindow(config: ApplicationConfig): BrowserWindow {
    this.#assertRendererAuthority();
    this.#allowWindowDestruction = false;
    const window = new BrowserWindow({
      width: 980,
      height: 760,
      minWidth: 760,
      minHeight: 640,
      title: 'Flasher',
      backgroundColor: '#080b10',
      ...(process.platform === 'darwin' ? {
        titleBarStyle: 'hiddenInset' as const,
        trafficLightPosition: { x: 18, y: 20 },
      } : {}),
      show: false,
      webPreferences: secureRendererWebPreferences(),
    });
    // The renderer needs no Chromium permission surface (USB, serial, media,
    // geolocation, notifications, clipboard-read, etc.). Keep those separate
    // from the narrowly contracted preload API.
    denyRendererPermissions(window);
    window.once('ready-to-show', () => window.show());
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternalUrl(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    const preventUntrustedNavigation = (event: Electron.Event, url: string) => {
      if (!this.#trustedRenderer || !isTrustedRendererUrl(url, this.#trustedRenderer)) event.preventDefault();
    };
    window.webContents.on('will-navigate', preventUntrustedNavigation);
    window.webContents.on('will-redirect', preventUntrustedNavigation);

    const developmentUrl = config.developmentServerUrl;
    let rendererLoad: Promise<void>;
    if (developmentUrl) {
      this.#trustedRenderer = { mode: 'development', origin: developmentUrl.origin };
      rendererLoad = window.loadURL(developmentUrl.href);
    } else {
      const rendererPath = join(import.meta.dirname, '../renderer/index.html');
      this.#trustedRenderer = { mode: 'production', url: pathToFileURL(rendererPath).href };
      rendererLoad = window.loadFile(rendererPath);
    }
    void rendererLoad.catch((value) => {
      console.error('Flasher renderer failed to load', value);
      dialog.showErrorBox('Flasher renderer could not load', errorMessage(value));
      if (!window.isDestroyed()) window.destroy();
      app.quit();
    });
    window.on('close', (event) => {
      if (this.#allowWindowDestruction) return;
      event.preventDefault();
      void this.#requestWindowRelease(window);
    });
    window.on('closed', () => {
      if (this.#window === window) {
        this.#window = undefined;
        this.#trustedRenderer = undefined;
      }
    });
    return window;
  }

  async #requestWindowRelease(window: BrowserWindow): Promise<void> {
    if (this.#windowReleaseInFlight || window.isDestroyed()) return;
    const application = this.#application;
    if (!application) return;
    if (application.criticalSection !== 'none') {
      window.show();
      await dialog.showMessageBox(window, criticalSectionDialog());
      return;
    }
    this.#windowReleaseInFlight = true;
    try {
      const result = await application.releaseForWindowClose();
      if (result === 'blocked-critical') {
        if (!window.isDestroyed()) await dialog.showMessageBox(window, criticalSectionDialog());
        return;
      }
      this.#allowWindowDestruction = true;
      if (!window.isDestroyed()) window.destroy();
    } catch (value) {
      console.error('Flasher safe window release failed', value);
      if (!window.isDestroyed()) await dialog.showMessageBox(window, safeDisconnectError(value));
    } finally {
      this.#windowReleaseInFlight = false;
    }
  }

  async #requestSafeQuit(): Promise<void> {
    if (this.#shutdownInFlight) return;
    const application = this.#application;
    if (!application) {
      this.#quitApproved = true;
      this.#disposeDevelopmentHostLifetime();
      app.quit();
      return;
    }
    const window = this.#liveWindow();
    if (application.criticalSection !== 'none') {
      window?.show();
      const options = criticalSectionDialog();
      await (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options));
      return;
    }
    this.#shutdownInFlight = true;
    try {
      const result = await application.requestShutdown();
      if (result === 'blocked-critical') return;
      this.#quitApproved = true;
      this.#allowWindowDestruction = true;
      this.#removeIpc?.();
      this.#removeIpc = undefined;
      this.#disposeDevelopmentHostLifetime();
      app.quit();
    } catch (value) {
      console.error('Flasher safe shutdown failed', value);
      const options = safeDisconnectError(value);
      await (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options));
    } finally {
      this.#shutdownInFlight = false;
    }
  }

  #liveWindow(): BrowserWindow | undefined {
    return this.#window && !this.#window.isDestroyed() ? this.#window : undefined;
  }

  #isTrustedEvent(event: IpcMainInvokeEvent): boolean {
    const window = this.#liveWindow();
    return Boolean(!this.#developmentRendererQuarantined
      && (this.#developmentHostLifetime?.available ?? true)
      && window
      && this.#trustedRenderer
      && event.sender === window.webContents
      && event.senderFrame === window.webContents.mainFrame
      && isTrustedRendererUrl(event.senderFrame.url, this.#trustedRenderer));
  }

  #assertRendererAuthority(): void {
    if (this.#developmentRendererQuarantined) {
      throw new Error('The development renderer is permanently quarantined because its host lifetime ended');
    }
    this.#developmentHostLifetime?.assertAvailable();
  }

  #quarantineDevelopmentRenderer(reason: string): void {
    if (this.#developmentRendererQuarantined) return;
    this.#developmentRendererQuarantined = true;
    console.error(`${reason}. Flasher revoked the development renderer and will not recreate it.`);
    // Removing handlers and trust is synchronous and does not cancel an IPC
    // operation that already crossed into the main-process application. A
    // confirmed firmware write/post-write verification therefore continues to
    // its durable terminal state even though the replaceable renderer is gone.
    this.#trustedRenderer = undefined;
    this.#removeIpc?.();
    this.#removeIpc = undefined;
    const window = this.#liveWindow();
    if (window) {
      this.#allowWindowDestruction = true;
      window.destroy();
    }
  }

  #disposeDevelopmentHostLifetime(): void {
    this.#developmentHostLifetime?.dispose();
    this.#developmentHostLifetime = undefined;
  }
}

async function runRuntimeSmoke(): Promise<void> {
  const window = new BrowserWindow({
    show: false,
    webPreferences: secureRendererWebPreferences(),
  });
  denyRendererPermissions(window);
  await window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  const rendererState: unknown = await window.webContents.executeJavaScript(`new Promise((resolve) => {
    const deadline = Date.now() + 5000;
    const inspect = () => {
      const api = window.tinySaFlasher;
      const operations = api && Object.keys(api).sort();
      const expected = ${JSON.stringify([
        'capabilities', 'connectDevice', 'detectDfu', 'disconnectDevice', 'download', 'flash', 'prepare',
        'recoverDevice', 'refreshPrerequisites', 'scanDevices', 'selectLocalFirmwareTarget',
        'selectOemTarget', 'snapshot',
      ].sort())};
      const rendererLoaded = document.querySelector('#root h1')?.textContent === 'Flasher';
      const preloadApi = Array.isArray(operations)
        && operations.length === expected.length
        && operations.every((operation, index) => operation === expected[index])
        && operations.every((operation) => typeof api[operation] === 'function');
      if (rendererLoaded && preloadApi) resolve({ rendererLoaded, preloadApi });
      else if (Date.now() >= deadline) resolve({ rendererLoaded, preloadApi, operations });
      else setTimeout(inspect, 25);
    };
    inspect();
  })`, true);
  if (!isSuccessfulRendererSmoke(rendererState)) {
    throw new Error(`Packaged renderer/preload smoke failed: ${JSON.stringify(rendererState)}`);
  }
  window.destroy();
  process.stdout.write(`TINYSA_FLASHER_RUNTIME_SMOKE_OK ${JSON.stringify({
    name: app.getName(),
    version: app.getVersion(),
    packaged: app.isPackaged,
    architecture: process.arch,
    electron: process.versions.electron,
    ...rendererState,
  })}\n`);
  app.exit(0);
}

function secureRendererWebPreferences(): WebPreferences {
  return {
    preload: join(import.meta.dirname, 'preload.cjs'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
  };
}

function denyRendererPermissions(window: BrowserWindow): void {
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
}

function isSuccessfulRendererSmoke(value: unknown): value is { rendererLoaded: true; preloadApi: true } {
  return typeof value === 'object'
    && value !== null
    && Reflect.get(value, 'rendererLoaded') === true
    && Reflect.get(value, 'preloadApi') === true;
}

function criticalSectionDialog() {
  return {
    type: 'warning' as const,
    title: 'Firmware safety operation in progress',
    message: 'Flasher must remain open through confirmation, dfu-util exit, and post-reboot verification.',
    buttons: ['Keep Flasher open'],
  };
}

function safeDisconnectError(value: unknown) {
  return {
    type: 'error' as const,
    title: 'Safe disconnect failed',
    message: 'Flasher did not confirm RF output off and USB disconnect. The app will remain open.',
    detail: errorMessage(value),
    buttons: ['Return to Flasher'],
  };
}

function isAllowedExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'tinysa.org' || url.hostname === 'www.tinysa.org');
  } catch { return false; }
}

function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value); }

if (singleInstance) {
  const host = new DesktopHost();
  host.installLifecycle();
  void app.whenReady().then(runtimeSmoke ? runRuntimeSmoke : () => host.start()).catch((value) => {
    console.error('Flasher startup failed', value);
    dialog.showErrorBox('Flasher could not start', errorMessage(value));
    app.quit();
  });
}
