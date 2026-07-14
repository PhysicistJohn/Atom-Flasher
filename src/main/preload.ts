import { contextBridge, ipcRenderer } from 'electron';
import type { FirmwareUpdatePreflight, PortCandidate } from '../core/contracts.js';
import { IPC, type TinySaFlasherApi } from './ipc-contract.js';

const api: TinySaFlasherApi = {
  listDevices: () => ipcRenderer.invoke(IPC.listDevices),
  deviceState: () => ipcRenderer.invoke(IPC.deviceState),
  connectDevice: (candidate: PortCandidate) => ipcRenderer.invoke(IPC.connectDevice, candidate),
  disconnectDevice: () => ipcRenderer.invoke(IPC.disconnectDevice),
  updateState: () => ipcRenderer.invoke(IPC.updateState),
  download: () => ipcRenderer.invoke(IPC.download),
  prepare: (preflight: FirmwareUpdatePreflight) => ipcRenderer.invoke(IPC.prepare, preflight),
  detectDfu: () => ipcRenderer.invoke(IPC.detectDfu),
  refreshPrerequisites: () => ipcRenderer.invoke(IPC.refreshPrerequisites),
  flash: (preparationId: string) => ipcRenderer.invoke(IPC.flash, preparationId),
};

contextBridge.exposeInMainWorld('tinySaFlasher', Object.freeze(api));
