import {
  OEM_ZS407_FIRMWARE_RELEASE,
  OEM_ZS407_SELF_TEST_PROCEDURE,
  ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT,
  ZS407_SHIPPED_FIRMWARE_VERSION,
  initialFirmwareUpdateState,
  type DeviceSnapshot,
  type FirmwarePreparation,
  type FirmwareUpdateState,
  type PortCandidate,
} from '../core/contracts.js';
import {
  applicationActionResultSchema,
  applicationSnapshotSchema,
  deriveAllowedActions,
  type ApplicationActionResult,
  type ApplicationSnapshot,
} from '../application/application-contract.js';
import { IPC_CAPABILITIES, parseIpcRequest, type TinySaFlasherApi } from '../main/ipc-contract.js';

const now = '2026-07-14T16:00:00.000Z';
const exactDevice: PortCandidate = Object.freeze({
  id: 'safe-mock-zs407',
  path: '/dev/mock.tinySA-ZS407',
  vendorId: '0483',
  productId: '5740',
  serialNumber: 'SAFE-MOCK-NOT-HARDWARE',
  manufacturer: 'TinySA safe renderer mock',
  usbMatch: 'exact-zs407-cdc',
});
const rejectedDevice: PortCandidate = Object.freeze({
  id: 'safe-mock-rejected',
  path: '/dev/mock.rejected',
  vendorId: '1234',
  productId: '5678',
  manufacturer: 'Safe renderer mock',
  usbMatch: 'unverified-serial',
});

const disconnected: DeviceSnapshot = { connection: 'disconnected' };
const connected: DeviceSnapshot = {
  connection: 'ready',
  connectedAt: now,
  telemetry: { batteryMillivolts: 4211, deviceId: 407, capturedAt: now },
  identity: {
    model: 'tinySA Ultra+ ZS407',
    hardwareVersion: 'SAFE MOCK ZS407',
    firmwareVersion: ZS407_SHIPPED_FIRMWARE_VERSION,
    firmwareReportedRevision: 'c5dd31f',
    firmwareSourceCommit: ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT,
    firmwareQualification: 'supported-oem',
    port: exactDevice,
    usbIdentityVerified: true,
  },
};

const current = Object.freeze({
  version: ZS407_SHIPPED_FIRMWARE_VERSION,
  revision: 'c5dd31f' as const,
  sourceCommit: ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT,
  qualification: 'supported-oem' as const,
});
const artifact = Object.freeze({
  sizeBytes: OEM_ZS407_FIRMWARE_RELEASE.sizeBytes,
  sha256: OEM_ZS407_FIRMWARE_RELEASE.sha256,
  verifiedAt: now,
});
const preparation: FirmwarePreparation = {
  id: '11111111-1111-4111-8111-111111111111',
  preparedAt: now,
  batteryMillivolts: 4211,
  deviceId: 407,
  screenSha256: 'a'.repeat(64),
  selfTestPassed: true,
  selfTestProcedure: OEM_ZS407_SELF_TEST_PROCEDURE.id,
  configurationDisposition: 'new-device-unchanged',
  rfPortsDisconnected: true,
  onlyUsbDeviceConnected: true,
  usbContinuity: {
    cdcPath: exactDevice.path,
    cdcSerialNumber: exactDevice.serialNumber,
    vendorId: '0483',
    productId: '5740',
    deviceId: 407,
  },
};

export function installSafeRendererMock(): void {
  let device: DeviceSnapshot = disconnected;
  let update: FirmwareUpdateState = initialFirmwareUpdateState();
  let sequence = 0;
  let candidates: readonly PortCandidate[] = [];

  const snapshot = (): ApplicationSnapshot => {
    const activity = { criticalSection: 'none' as const, admission: 'accepting' as const };
    return applicationSnapshotSchema.parse({
      schemaVersion: 2,
      instanceId: '22222222-2222-4222-8222-222222222222',
      sequence: ++sequence,
      capturedAt: now,
      activity,
      discovery: {
        candidates,
        ...(candidates.length > 0 ? { scannedAt: now } : {}),
      },
      device,
      update,
      allowedActions: deriveAllowedActions(device, update, activity),
    });
  };
  const completed = (): ApplicationActionResult => applicationActionResultSchema.parse({
    outcome: 'completed',
    snapshot: snapshot(),
  });

  const api: TinySaFlasherApi = {
    capabilities: async () => IPC_CAPABILITIES,
    snapshot: async () => snapshot(),
    scanDevices: async () => {
      candidates = [exactDevice, rejectedDevice];
      return completed();
    },
    connectDevice: async (candidate) => {
      const [input] = parseIpcRequest('connectDevice', [candidate]);
      if (input.id !== exactDevice.id) throw new Error('The safe mock accepts only its exact synthetic ZS407');
      device = connected;
      update = {
        ...initialFirmwareUpdateState(),
        phase: 'available',
        current,
        targetRelation: 'different-supported',
        writeIntent: 'update-oem',
        updateAvailable: true,
        dfuUtility: { available: true, version: '0.11' },
      };
      return completed();
    },
    disconnectDevice: async () => {
      device = disconnected;
      return completed();
    },
    recoverDevice: async () => {
      device = disconnected;
      return completed();
    },
    selectOemTarget: async () => completed(),
    selectLocalFirmwareTarget: async () => {
      throw new Error('The safe browser mock cannot open a native firmware manifest picker');
    },
    download: async () => {
      requirePhase(update, 'available');
      update = { ...update, phase: 'verified', artifact };
      return completed();
    },
    prepare: async (preflight) => {
      parseIpcRequest('prepare', [preflight]);
      requirePhase(update, 'verified');
      device = disconnected;
      update = { ...update, phase: 'awaiting-dfu', preparation };
      return completed();
    },
    detectDfu: async () => {
      requirePhase(update, 'awaiting-dfu');
      update = {
        ...update,
        phase: 'ready-to-flash',
        dfuDevice: {
          detected: true,
          count: 1,
          identity: {
            path: 'SAFE-MOCK-DFU-PATH',
            devnum: '1',
            serial: 'SAFE-MOCK-DFU-SERIAL',
            alt: 0,
            name: '@Internal Flash /0x08000000/01*016Kg,03*016Kg,01*064Kg,07*128Kg',
            fingerprint: '{"path":"SAFE-MOCK-DFU-PATH","devnum":"1","serial":"SAFE-MOCK-DFU-SERIAL","alt":0,"name":"@Internal Flash /0x08000000/01*016Kg,03*016Kg,01*064Kg,07*128Kg"}',
            targetLine: 'Found DFU: [0483:df11] devnum=1, path="SAFE-MOCK-DFU-PATH", alt=0, name="@Internal Flash /0x08000000/01*016Kg,03*016Kg,01*064Kg,07*128Kg", serial="SAFE-MOCK-DFU-SERIAL"',
          },
        },
      };
      return completed();
    },
    refreshPrerequisites: async () => completed(),
    flash: async (preparationId) => {
      parseIpcRequest('flash', [preparationId]);
      return applicationActionResultSchema.parse({ outcome: 'cancelled', snapshot: snapshot() });
    },
  };

  Object.defineProperty(window, 'tinySaFlasher', { configurable: true, value: Object.freeze(api) });
  const banner = document.createElement('div');
  banner.setAttribute('role', 'status');
  banner.textContent = 'SAFE RENDERER MOCK · NO ELECTRON, SERIAL, NETWORK, FILESYSTEM, OR DFU ACCESS';
  Object.assign(banner.style, {
    background: '#f2b134',
    color: '#130f05',
    font: '700 12px/30px ui-monospace, SFMono-Regular, monospace',
    letterSpacing: '0.06em',
    position: 'sticky',
    textAlign: 'center',
    top: '0',
    zIndex: '10000',
  });
  document.body.prepend(banner);
}

function requirePhase(state: FirmwareUpdateState, expected: FirmwareUpdateState['phase']): void {
  if (state.phase !== expected) throw new Error(`Safe mock expected ${expected}, received ${state.phase}`);
}
