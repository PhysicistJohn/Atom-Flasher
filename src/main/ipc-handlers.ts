import type { ApplicationActionResult, ApplicationSnapshot } from '../application/application-contract.js';
import type { FirmwareUpdatePreflight, PortCandidate } from '../core/contracts.js';
import {
  IPC,
  IPC_CAPABILITIES,
  makeIpcFailure,
  makeIpcSuccess,
  parseIpcRequest,
  type IpcErrorCode,
  type IpcOperation,
  type IpcOutput,
  type IpcRequest,
  type IpcWireReply,
} from './ipc-contract.js';

export interface IpcRegistrar<Event = unknown> {
  handle(channel: string, listener: (event: Event, ...args: unknown[]) => Promise<unknown>): void;
  removeHandler(channel: string): void;
}

/** Domain-facing port consumed by the Electron IPC adapter. */
export interface ApplicationIpcPort {
  snapshot(): ApplicationSnapshot;
  scanDevices(): Promise<ApplicationActionResult>;
  connectDevice(candidate: PortCandidate): Promise<ApplicationActionResult>;
  disconnectDevice(): Promise<ApplicationActionResult>;
  recoverDevice(): Promise<ApplicationActionResult>;
  selectOemTarget(): Promise<ApplicationActionResult>;
  selectLocalFirmwareTarget(): Promise<ApplicationActionResult>;
  download(): Promise<ApplicationActionResult>;
  prepare(preflight: FirmwareUpdatePreflight): Promise<ApplicationActionResult>;
  detectDfu(): Promise<ApplicationActionResult>;
  refreshPrerequisites(): Promise<ApplicationActionResult>;
  flash(preparationId: string): Promise<ApplicationActionResult>;
}

export interface ApplicationIpcDependencies<Event = unknown> {
  registrar: IpcRegistrar<Event>;
  application: ApplicationIpcPort;
  isTrusted(event: Event): boolean;
}

export function registerApplicationIpc<Event>(dependencies: ApplicationIpcDependencies<Event>): () => void {
  const { application, registrar } = dependencies;
  const register = <K extends IpcOperation>(
    operation: K,
    handler: (...args: IpcRequest<K>) => Promise<IpcOutput<K>> | IpcOutput<K>,
  ) => registrar.handle(IPC[operation], createContractedHandler(operation, handler, dependencies));

  register('capabilities', () => IPC_CAPABILITIES);
  register('snapshot', () => application.snapshot());
  register('scanDevices', () => application.scanDevices());
  register('connectDevice', (candidate) => application.connectDevice(candidate));
  register('disconnectDevice', () => application.disconnectDevice());
  register('recoverDevice', () => application.recoverDevice());
  register('selectOemTarget', () => application.selectOemTarget());
  register('selectLocalFirmwareTarget', () => application.selectLocalFirmwareTarget());
  register('download', () => application.download());
  register('prepare', (preflight) => application.prepare(preflight));
  register('detectDfu', () => application.detectDfu());
  register('refreshPrerequisites', () => application.refreshPrerequisites());
  register('flash', (preparationId) => application.flash(preparationId));

  return () => {
    for (const channel of Object.values(IPC)) registrar.removeHandler(channel);
  };
}

export function createContractedHandler<Event, K extends IpcOperation>(
  operation: K,
  handler: (...args: IpcRequest<K>) => Promise<IpcOutput<K>> | IpcOutput<K>,
  dependencies: Pick<ApplicationIpcDependencies<Event>, 'application' | 'isTrusted'>,
): (event: Event, ...rawArguments: unknown[]) => Promise<IpcWireReply<K>> {
  return async (event, ...rawArguments) => {
    if (!dependencies.isTrusted(event)) throw new Error('Rejected IPC from an untrusted renderer frame or origin');
    let args: IpcRequest<K>;
    try {
      args = parseIpcRequest(operation, rawArguments);
    } catch (value) {
      return makeIpcFailure(operation, {
        code: 'INVALID_REQUEST',
        boundary: 'request',
        message: boundedMessage(value),
        retryable: false,
        manualAction: 'none',
      });
    }

    let output: IpcOutput<K>;
    try {
      output = await handler(...args);
    } catch (value) {
      const classification = classifyIpcFailure(operation, value, safeWriteDisposition(dependencies.application));
      return makeIpcFailure(operation, {
        ...classification,
        boundary: 'operation',
        message: boundedMessage(value),
      });
    }

    try {
      return makeIpcSuccess(operation, output);
    } catch (value) {
      return makeIpcFailure(operation, {
        code: 'INVALID_RESPONSE',
        boundary: 'response',
        message: `Main process produced an invalid ${operation} response: ${boundedMessage(value)}`,
        retryable: false,
        manualAction: 'none',
      });
    }
  };
}

function safeWriteDisposition(application: ApplicationIpcPort): string | undefined {
  try { return application.snapshot().update.writeDisposition; }
  catch { return undefined; }
}

export function classifyIpcFailure(
  operation: IpcOperation,
  value: unknown,
  writeDisposition?: string,
): { code: IpcErrorCode; retryable: boolean; manualAction: 'none' | 'power-off-device' | 'inspect-safety-evidence' | 'do-not-retry-write' } {
  const detail = errorMessage(value);
  if (/already active|admission is draining/i.test(detail)) {
    return { code: 'OPERATION_BUSY', retryable: true, manualAction: 'none' };
  }
  if (operation === 'connectDevice') return { code: 'DEVICE_ADMISSION_FAILED', retryable: true, manualAction: 'none' };
  if (operation === 'disconnectDevice' || operation === 'recoverDevice') {
    return { code: 'DEVICE_SAFETY_FAULT', retryable: false, manualAction: 'power-off-device' };
  }
  const updateOperation = operation === 'selectOemTarget'
    || operation === 'selectLocalFirmwareTarget'
    || operation === 'download'
    || operation === 'prepare'
    || operation === 'detectDfu'
    || operation === 'refreshPrerequisites'
    || operation === 'flash';
  if (updateOperation && writeDisposition !== undefined && writeDisposition !== 'not-started') {
    return { code: 'WRITE_INDETERMINATE', retryable: false, manualAction: 'do-not-retry-write' };
  }
  if (updateOperation && /journal|evidence|lock|owned by another|indeterminate|durable|write attempt already/i.test(detail)) {
    return { code: 'EVIDENCE_INDETERMINATE', retryable: false, manualAction: 'inspect-safety-evidence' };
  }
  if (updateOperation && /application policy does not allow|not legal|precondition|requires .*current state/i.test(detail)) {
    return { code: 'UPDATE_PRECONDITION_FAILED', retryable: true, manualAction: 'none' };
  }
  if (operation === 'download') {
    const precondition = /requires one connected|already runs|not legal|disabled while custom|write attempt already|indeterminate/i.test(detail);
    return {
      code: precondition ? 'UPDATE_PRECONDITION_FAILED' : 'FIRMWARE_SOURCE_FAILED',
      retryable: true,
      manualAction: 'none',
    };
  }
  if (operation === 'selectOemTarget' || operation === 'selectLocalFirmwareTarget') {
    return { code: 'FIRMWARE_SOURCE_FAILED', retryable: true, manualAction: 'none' };
  }
  if (operation === 'prepare') return { code: 'PREFLIGHT_FAILED', retryable: true, manualAction: 'none' };
  if (operation === 'detectDfu' || operation === 'refreshPrerequisites') {
    return { code: 'DFU_ADMISSION_FAILED', retryable: true, manualAction: 'none' };
  }
  if (operation === 'flash') {
    if (/dfu|target|identity|device count/i.test(detail)) {
      return { code: 'DFU_ADMISSION_FAILED', retryable: true, manualAction: 'none' };
    }
  }
  return { code: 'OPERATION_FAILED', retryable: false, manualAction: 'none' };
}

function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function boundedMessage(value: unknown): string {
  return errorMessage(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 4_096)
    || 'Unknown IPC failure';
}
