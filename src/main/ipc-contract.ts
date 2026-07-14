import type { DeviceSnapshot, FirmwareUpdatePreflight, FirmwareUpdateState, PortCandidate } from '../core/contracts.js';

export const IPC = Object.freeze({
  listDevices: 'flasher:device:list',
  deviceState: 'flasher:device:state',
  connectDevice: 'flasher:device:connect',
  disconnectDevice: 'flasher:device:disconnect',
  updateState: 'flasher:update:state',
  download: 'flasher:update:download',
  prepare: 'flasher:update:prepare',
  detectDfu: 'flasher:update:detect-dfu',
  refreshPrerequisites: 'flasher:update:refresh-prerequisites',
  flash: 'flasher:update:flash',
} as const);

export type NativeFlashResult =
  | { status: 'cancelled'; state: FirmwareUpdateState }
  | { status: 'completed'; state: FirmwareUpdateState };

export interface TinySaFlasherApi {
  listDevices(): Promise<readonly PortCandidate[]>;
  deviceState(): Promise<DeviceSnapshot>;
  connectDevice(candidate: PortCandidate): Promise<DeviceSnapshot>;
  disconnectDevice(): Promise<DeviceSnapshot>;
  updateState(): Promise<FirmwareUpdateState>;
  download(): Promise<FirmwareUpdateState>;
  prepare(preflight: FirmwareUpdatePreflight): Promise<FirmwareUpdateState>;
  detectDfu(): Promise<FirmwareUpdateState>;
  refreshPrerequisites(): Promise<FirmwareUpdateState>;
  flash(preparationId: string): Promise<NativeFlashResult>;
}
