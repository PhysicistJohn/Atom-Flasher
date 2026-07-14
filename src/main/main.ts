import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, app, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { firmwareUpdatePreflightSchema, portCandidateSchema } from '../core/contracts.js';
import { FirmwareUpdater } from '../core/firmware-updater.js';
import { migrateLegacyFirmwareState } from '../core/legacy-migration.js';
import { Zs407DeviceService } from '../device/device-service.js';
import { IPC } from './ipc-contract.js';
import { OperationGate } from './operation-gate.js';
import { isTrustedRendererUrl, selectDevelopmentServerUrl } from './security.js';

app.setName('TinySA Flasher');
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

let mainWindow: BrowserWindow | undefined;
let firmwareWriteBoundaryActive = false;
let nativeFlashRequestInFlight = false;
let shutdownDevice: Zs407DeviceService | undefined;
let safeShutdownComplete = false;
let safeShutdownStarted = false;
let trustedRenderer: { developmentOrigin?: string; productionUrl?: string } = {};
const operationGate = new OperationGate();

if (singleInstance) {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on('before-quit', (event) => {
    if (firmwareWriteBoundaryActive || operationGate.active === 'flash-firmware') {
      event.preventDefault();
      mainWindow?.show();
      const options = {
        type: 'warning' as const,
        title: 'Firmware write in progress',
        message: 'TinySA Flasher must remain open until dfu-util exits and post-reboot verification finishes.',
        buttons: ['Keep TinySA Flasher open'],
      };
      void (mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options));
      return;
    }
    if (safeShutdownComplete || !shutdownDevice) return;
    event.preventDefault();
    if (safeShutdownStarted) return;
    safeShutdownStarted = true;
    void operationGate.whenIdle().then(() => operationGate.run('shutdown-disconnect', async () => {
      if (shutdownDevice?.snapshot().connection !== 'disconnected') await shutdownDevice?.disconnect();
    })).then(() => {
      safeShutdownComplete = true;
      app.quit();
    }).catch((value) => {
      safeShutdownStarted = false;
      const options = {
        type: 'error' as const,
        title: 'Safe disconnect failed',
        message: 'TinySA Flasher did not confirm RF output off and USB disconnect. The app will remain open.',
        detail: message(value),
        buttons: ['Return to TinySA Flasher'],
      };
      void (mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options));
    });
  });

  void app.whenReady().then(startApplication).catch((value) => {
    dialog.showErrorBox('TinySA Flasher could not start', message(value));
    app.quit();
  });
}

async function startApplication(): Promise<void> {
  const userData = app.getPath('userData');
  const applicationData = app.getPath('appData');
  await migrateLegacyFirmwareState(join(userData, 'firmware'), [
    join(applicationData, 'TinySA Atomizer', 'firmware'),
    join(applicationData, 'TinySA Atomizer Dev', 'firmware'),
  ]);

  const device = new Zs407DeviceService();
  shutdownDevice = device;
  const updater = new FirmwareUpdater(join(userData, 'firmware'), device);
  await updater.state();
  registerIpc(device, updater);
  mainWindow = createWindow();
  mainWindow.on('close', (event) => {
    if (!firmwareWriteBoundaryActive) return;
    event.preventDefault();
    mainWindow?.show();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 760,
    minHeight: 640,
    title: 'TinySA Flasher',
    backgroundColor: '#080b10',
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://tinysa.org/')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  const preventUntrustedNavigation = (event: Electron.Event, url: string) => {
    if (!isTrustedRendererUrl(url, trustedRenderer)) event.preventDefault();
  };
  window.webContents.on('will-navigate', preventUntrustedNavigation);
  window.webContents.on('will-redirect', preventUntrustedNavigation);
  const developmentUrl = selectDevelopmentServerUrl(process.env.VITE_DEV_SERVER_URL, app.isPackaged);
  let rendererLoad: Promise<void>;
  if (developmentUrl) {
    trustedRenderer = { developmentOrigin: developmentUrl.origin };
    rendererLoad = window.loadURL(developmentUrl.href);
  } else {
    const rendererPath = join(import.meta.dirname, '../renderer/index.html');
    trustedRenderer = { productionUrl: pathToFileURL(rendererPath).href };
    rendererLoad = window.loadFile(rendererPath);
  }
  void rendererLoad.catch((value) => {
    dialog.showErrorBox('TinySA Flasher renderer could not load', message(value));
    if (!window.isDestroyed()) window.destroy();
    app.quit();
  });
  return window;
}

function registerIpc(device: Zs407DeviceService, updater: FirmwareUpdater): void {
  const gate = operationGate;
  ipcMain.handle(IPC.listDevices, trusted(() => gate.run('list-devices', () => device.listDevices())));
  ipcMain.handle(IPC.deviceState, trusted(() => gate.peek(() => device.snapshot())));
  ipcMain.handle(IPC.connectDevice, trusted((_event, input: unknown) => gate.run('connect-device', async () => {
    const connected = await device.connect(portCandidateSchema.parse(input));
    await updater.state();
    return connected;
  })));
  ipcMain.handle(IPC.disconnectDevice, trusted(() => gate.run('disconnect-device', async () => {
    await device.disconnect();
    await updater.state();
    return device.snapshot();
  })));
  ipcMain.handle(IPC.updateState, trusted(() => gate.peek(() => updater.snapshot())));
  ipcMain.handle(IPC.download, trusted(() => gate.run('download-firmware', () => updater.download())));
  ipcMain.handle(IPC.prepare, trusted((_event, input: unknown) => gate.run('prepare-firmware', () => updater.prepare(firmwareUpdatePreflightSchema.parse(input)))));
  ipcMain.handle(IPC.detectDfu, trusted(() => gate.run('detect-dfu', () => updater.detectDfu())));
  ipcMain.handle(IPC.refreshPrerequisites, trusted(() => gate.run('refresh-prerequisites', () => updater.refreshPrerequisites())));
  ipcMain.handle(IPC.flash, trusted(async (_event, preparationId: unknown) => gate.run('flash-firmware', async () => {
    if (nativeFlashRequestInFlight) throw new Error('A native firmware confirmation or write request is already active');
    nativeFlashRequestInFlight = true;
    try {
    if (typeof preparationId !== 'string') throw new TypeError('preparationId must be a string');
    const state = updater.snapshot();
    if (state.phase !== 'ready-to-flash' || state.preparation?.id !== preparationId) throw new Error('The renderer flash request does not match the active ready preparation');
    const owner = mainWindow;
    if (!owner) throw new Error('The trusted application window is unavailable');
    const confirmation = await dialog.showMessageBox(owner, {
      type: 'warning',
      title: 'Write firmware to internal flash?',
      message: 'This is the only action that writes the tinySA internal flash.',
      detail: `TinySA Flasher will write only ${state.target.version}. Keep USB and power connected until post-reboot identity verification completes.`,
      buttons: ['Cancel', 'Flash verified OEM firmware'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
      if (confirmation.response !== 1) return { status: 'cancelled' as const, state: updater.snapshot() };
      firmwareWriteBoundaryActive = true;
      try {
        const completed = await updater.flash({ preparationId, confirmation: 'FLASH VERIFIED OEM FIRMWARE' });
        return { status: 'completed' as const, state: completed };
      } finally {
        firmwareWriteBoundaryActive = false;
      }
    } finally {
      nativeFlashRequestInFlight = false;
    }
  })));
}

function trusted<T extends readonly unknown[], R>(handler: (event: IpcMainInvokeEvent, ...args: T) => R): (event: IpcMainInvokeEvent, ...args: T) => R {
  return (event, ...args) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame
      || !isTrustedRendererUrl(event.senderFrame.url, trustedRenderer)) {
      throw new Error('Rejected IPC from an untrusted renderer frame or origin');
    }
    return handler(event, ...args);
  };
}

function message(value: unknown): string { return value instanceof Error ? value.stack ?? value.message : String(value); }
