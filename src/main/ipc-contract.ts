import { z } from 'zod';
import {
  firmwareUpdatePreflightSchema,
  portCandidateSchema,
  uuidSchema,
} from '../core/contracts.js';
import {
  applicationActionResultSchema,
  applicationSnapshotSchema,
} from '../application/application-contract.js';

export const IPC_PROTOCOL_VERSION = 2 as const;
export const IPC_CONTRACT_ID = 'tinysa-flasher-renderer-ipc' as const;

const IPC_OPERATION_NAMES = [
  'capabilities',
  'snapshot',
  'scanDevices',
  'connectDevice',
  'disconnectDevice',
  'recoverDevice',
  'selectOemTarget',
  'selectLocalFirmwareTarget',
  'download',
  'prepare',
  'detectDfu',
  'refreshPrerequisites',
  'flash',
] as const;

export const ipcOperationSchema = z.enum(IPC_OPERATION_NAMES);
export type IpcOperation = z.infer<typeof ipcOperationSchema>;

export const ipcCapabilitiesSchema = z.object({
  contractId: z.literal(IPC_CONTRACT_ID),
  protocolVersion: z.literal(IPC_PROTOCOL_VERSION),
  operations: z.array(ipcOperationSchema).length(IPC_OPERATION_NAMES.length).readonly(),
}).strict().superRefine((capabilities, context) => {
  if (capabilities.operations.some((operation, index) => operation !== IPC_OPERATION_NAMES[index])) {
    context.addIssue({ code: 'custom', message: 'IPC capabilities must list the exact ordered operation set' });
  }
});
export type IpcCapabilities = z.infer<typeof ipcCapabilitiesSchema>;

export const IPC_CAPABILITIES: IpcCapabilities = Object.freeze({
  contractId: IPC_CONTRACT_ID,
  protocolVersion: IPC_PROTOCOL_VERSION,
  operations: Object.freeze([...IPC_OPERATION_NAMES]),
});

export const ipcErrorCodeSchema = z.enum([
  'INVALID_REQUEST',
  'INVALID_RESPONSE',
  'IPC_PROTOCOL_MISMATCH',
  'OPERATION_BUSY',
  'DEVICE_ADMISSION_FAILED',
  'DEVICE_SAFETY_FAULT',
  'UPDATE_PRECONDITION_FAILED',
  'FIRMWARE_SOURCE_FAILED',
  'PREFLIGHT_FAILED',
  'DFU_ADMISSION_FAILED',
  'WRITE_INDETERMINATE',
  'EVIDENCE_INDETERMINATE',
  'OPERATION_FAILED',
  'INTERNAL_FAILURE',
]);
export type IpcErrorCode = z.infer<typeof ipcErrorCodeSchema>;

export const ipcErrorSchema = z.object({
  operation: ipcOperationSchema,
  code: ipcErrorCodeSchema,
  boundary: z.enum(['request', 'operation', 'response']),
  message: z.string().min(1).max(4_096),
  retryable: z.boolean(),
  manualAction: z.enum(['none', 'power-off-device', 'inspect-safety-evidence', 'do-not-retry-write']).optional(),
}).strict();
export type IpcError = z.infer<typeof ipcErrorSchema>;

function defineIpcContract<
  const Name extends IpcOperation,
  const Channel extends string,
  Input extends z.ZodType,
  Output extends z.ZodType,
>(name: Name, channel: Channel, input: Input, output: Output) {
  const reply = z.discriminatedUnion('ok', [
    z.object({
      protocolVersion: z.literal(IPC_PROTOCOL_VERSION),
      ok: z.literal(true),
      value: output,
    }).strict(),
    z.object({
      protocolVersion: z.literal(IPC_PROTOCOL_VERSION),
      ok: z.literal(false),
      error: ipcErrorSchema.extend({ operation: z.literal(name) }).strict(),
    }).strict(),
  ]);
  return Object.freeze({ name, channel, protocolVersion: IPC_PROTOCOL_VERSION, input, output, reply });
}

const noArgumentsSchema = z.tuple([]);

export const capabilitiesIpcContract = defineIpcContract(
  'capabilities', 'flasher:contract:capabilities', noArgumentsSchema, ipcCapabilitiesSchema,
);
export const snapshotIpcContract = defineIpcContract(
  'snapshot', 'flasher:application:snapshot', noArgumentsSchema, applicationSnapshotSchema,
);
export const scanDevicesIpcContract = defineIpcContract(
  'scanDevices', 'flasher:application:scan-devices', noArgumentsSchema, applicationActionResultSchema,
);
export const connectDeviceIpcContract = defineIpcContract(
  'connectDevice', 'flasher:application:connect-device', z.tuple([portCandidateSchema]), applicationActionResultSchema,
);
export const disconnectDeviceIpcContract = defineIpcContract(
  'disconnectDevice', 'flasher:application:disconnect-device', noArgumentsSchema, applicationActionResultSchema,
);
export const recoverDeviceIpcContract = defineIpcContract(
  'recoverDevice', 'flasher:application:recover-after-power-off', noArgumentsSchema, applicationActionResultSchema,
);
export const selectOemTargetIpcContract = defineIpcContract(
  'selectOemTarget', 'flasher:application:select-oem-target', noArgumentsSchema, applicationActionResultSchema,
);
export const selectLocalFirmwareTargetIpcContract = defineIpcContract(
  'selectLocalFirmwareTarget', 'flasher:application:select-local-firmware-target', noArgumentsSchema, applicationActionResultSchema,
);
export const downloadIpcContract = defineIpcContract(
  'download', 'flasher:application:download', noArgumentsSchema, applicationActionResultSchema,
);
export const prepareIpcContract = defineIpcContract(
  'prepare', 'flasher:application:prepare', z.tuple([firmwareUpdatePreflightSchema]), applicationActionResultSchema,
);
export const detectDfuIpcContract = defineIpcContract(
  'detectDfu', 'flasher:application:detect-dfu', noArgumentsSchema, applicationActionResultSchema,
);
export const refreshPrerequisitesIpcContract = defineIpcContract(
  'refreshPrerequisites', 'flasher:application:refresh-prerequisites', noArgumentsSchema, applicationActionResultSchema,
);
export const flashIpcContract = defineIpcContract(
  'flash', 'flasher:application:flash', z.tuple([uuidSchema]), applicationActionResultSchema,
);

/**
 * The sole renderer/main API registry. Each entry is independently consumable
 * and owns its channel, strict request tuple, domain output, and wire reply.
 */
export const IPC_CONTRACTS = Object.freeze({
  capabilities: capabilitiesIpcContract,
  snapshot: snapshotIpcContract,
  scanDevices: scanDevicesIpcContract,
  connectDevice: connectDeviceIpcContract,
  disconnectDevice: disconnectDeviceIpcContract,
  recoverDevice: recoverDeviceIpcContract,
  selectOemTarget: selectOemTargetIpcContract,
  selectLocalFirmwareTarget: selectLocalFirmwareTargetIpcContract,
  download: downloadIpcContract,
  prepare: prepareIpcContract,
  detectDfu: detectDfuIpcContract,
  refreshPrerequisites: refreshPrerequisitesIpcContract,
  flash: flashIpcContract,
});

export const IPC = Object.freeze({
  capabilities: capabilitiesIpcContract.channel,
  snapshot: snapshotIpcContract.channel,
  scanDevices: scanDevicesIpcContract.channel,
  connectDevice: connectDeviceIpcContract.channel,
  disconnectDevice: disconnectDeviceIpcContract.channel,
  recoverDevice: recoverDeviceIpcContract.channel,
  selectOemTarget: selectOemTargetIpcContract.channel,
  selectLocalFirmwareTarget: selectLocalFirmwareTargetIpcContract.channel,
  download: downloadIpcContract.channel,
  prepare: prepareIpcContract.channel,
  detectDfu: detectDfuIpcContract.channel,
  refreshPrerequisites: refreshPrerequisitesIpcContract.channel,
  flash: flashIpcContract.channel,
});

type ContractFor<K extends IpcOperation> = (typeof IPC_CONTRACTS)[K];
export type IpcRequest<K extends IpcOperation> = z.input<ContractFor<K>['input']> extends readonly unknown[]
  ? z.input<ContractFor<K>['input']>
  : never;
export type IpcOutput<K extends IpcOperation> = z.output<ContractFor<K>['output']>;
export type IpcWireReply<K extends IpcOperation> = z.output<ContractFor<K>['reply']>;

export type TinySaFlasherApi = {
  readonly [K in IpcOperation]: (...args: IpcRequest<K>) => Promise<IpcOutput<K>>;
};

export function parseIpcRequest<K extends IpcOperation>(operation: K, value: unknown): IpcRequest<K> {
  return IPC_CONTRACTS[operation].input.parse(value) as IpcRequest<K>;
}

export function parseIpcReply<K extends IpcOperation>(operation: K, value: unknown): IpcWireReply<K> {
  return IPC_CONTRACTS[operation].reply.parse(value) as IpcWireReply<K>;
}

/**
 * Renderer-side reply boundary. Malformed or version-skewed replies are
 * normalized into the same stable error contract as operation failures.
 */
export function unwrapIpcReply<K extends IpcOperation>(operation: K, value: unknown): IpcOutput<K> {
  let reply: IpcWireReply<K>;
  try {
    reply = parseIpcReply(operation, value);
  } catch {
    const receivedVersion = typeof value === 'object' && value !== null && 'protocolVersion' in value
      ? (value as { protocolVersion?: unknown }).protocolVersion
      : undefined;
    throw new IpcContractError({
      operation,
      code: receivedVersion !== undefined && receivedVersion !== IPC_PROTOCOL_VERSION
        ? 'IPC_PROTOCOL_MISMATCH'
        : 'INVALID_RESPONSE',
      boundary: 'response',
      message: receivedVersion !== undefined && receivedVersion !== IPC_PROTOCOL_VERSION
        ? `Renderer/main IPC protocol mismatch; expected version ${IPC_PROTOCOL_VERSION}`
        : `Main process returned an invalid ${operation} IPC response`,
      retryable: false,
      manualAction: 'none',
    });
  }
  if (!reply.ok) throw new IpcContractError(reply.error);
  return reply.value as IpcOutput<K>;
}

export function makeIpcSuccess<K extends IpcOperation>(operation: K, value: unknown): IpcWireReply<K> {
  return parseIpcReply(operation, { protocolVersion: IPC_PROTOCOL_VERSION, ok: true, value });
}

export function makeIpcFailure<K extends IpcOperation>(
  operation: K,
  error: Omit<IpcError, 'operation'>,
): IpcWireReply<K> {
  return parseIpcReply(operation, {
    protocolVersion: IPC_PROTOCOL_VERSION,
    ok: false,
    error: { operation, ...error },
  });
}

export class IpcContractError extends Error {
  override readonly name = 'IpcContractError';
  readonly operation: IpcOperation;
  readonly code: IpcErrorCode;
  readonly boundary: IpcError['boundary'];
  readonly retryable: boolean;
  readonly manualAction: IpcError['manualAction'];

  constructor(error: IpcError) {
    super(error.message);
    this.operation = error.operation;
    this.code = error.code;
    this.boundary = error.boundary;
    this.retryable = error.retryable;
    this.manualAction = error.manualAction;
  }
}
