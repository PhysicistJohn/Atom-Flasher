import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_CONTRACTS,
  parseIpcRequest,
  unwrapIpcReply,
  type IpcOperation,
  type IpcOutput,
  type IpcRequest,
  type TinySaFlasherApi,
} from './ipc-contract.js';

async function invokeContract<K extends IpcOperation>(operation: K, ...args: IpcRequest<K>): Promise<IpcOutput<K>> {
  const request = parseIpcRequest(operation, args) as readonly unknown[];
  const wireValue: unknown = await ipcRenderer.invoke(IPC_CONTRACTS[operation].channel, ...request);
  return unwrapIpcReply(operation, wireValue);
}

const api = Object.freeze({
  capabilities: () => invokeContract('capabilities'),
  snapshot: () => invokeContract('snapshot'),
  scanDevices: () => invokeContract('scanDevices'),
  connectDevice: (...args: IpcRequest<'connectDevice'>) => invokeContract('connectDevice', ...args),
  disconnectDevice: () => invokeContract('disconnectDevice'),
  recoverDevice: () => invokeContract('recoverDevice'),
  selectOemTarget: () => invokeContract('selectOemTarget'),
  selectLocalFirmwareTarget: () => invokeContract('selectLocalFirmwareTarget'),
  download: () => invokeContract('download'),
  prepare: (...args: IpcRequest<'prepare'>) => invokeContract('prepare', ...args),
  detectDfu: () => invokeContract('detectDfu'),
  refreshPrerequisites: () => invokeContract('refreshPrerequisites'),
  flash: (...args: IpcRequest<'flash'>) => invokeContract('flash', ...args),
}) satisfies TinySaFlasherApi;

contextBridge.exposeInMainWorld('tinySaFlasher', api);
