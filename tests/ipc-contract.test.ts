import { describe, expect, it } from 'vitest';
import {
  IPC_CAPABILITIES,
  IPC_CONTRACTS,
  IPC_PROTOCOL_VERSION,
  IpcContractError,
  makeIpcFailure,
  makeIpcSuccess,
  parseIpcReply,
  parseIpcRequest,
  unwrapIpcReply,
} from '../src/main/ipc-contract.js';

describe('versioned renderer IPC contract registry', () => {
  it('publishes one exact capability and unique channel per independently consumable operation', () => {
    expect(IPC_CAPABILITIES).toMatchObject({
      contractId: 'tinysa-flasher-renderer-ipc',
      protocolVersion: IPC_PROTOCOL_VERSION,
      operations: [
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
      ],
    });
    expect(IPC_CAPABILITIES.operations).toEqual(Object.keys(IPC_CONTRACTS));
    expect(new Set(Object.values(IPC_CONTRACTS).map((contract) => contract.channel)).size)
      .toBe(Object.keys(IPC_CONTRACTS).length);
  });

  it('rejects extra no-argument values and malformed operation inputs', () => {
    expect(parseIpcRequest('scanDevices', [])).toEqual([]);
    expect(() => parseIpcRequest('scanDevices', ['unexpected'])).toThrow();
    expect(() => parseIpcRequest('flash', ['not-a-uuid'])).toThrow();
    expect(() => parseIpcRequest('connectDevice', [{
      id: 'spoofed', path: '/dev/tty.spoofed', vendorId: '1234', productId: '5740', usbMatch: 'exact-zs407-cdc',
    }])).toThrow(/0483:5740/i);
  });

  it('validates successful values on both sides of the bridge', () => {
    const success = makeIpcSuccess('capabilities', IPC_CAPABILITIES);
    expect(parseIpcReply('capabilities', success)).toEqual(success);
    expect(() => makeIpcSuccess('snapshot', { connection: 'ready' })).toThrow();
    expect(() => parseIpcReply('capabilities', {
      protocolVersion: IPC_PROTOCOL_VERSION + 1,
      ok: true,
      value: IPC_CAPABILITIES,
    })).toThrow();
  });

  it('round-trips stable structured errors instead of relying on Electron error strings', () => {
    const failure = makeIpcFailure('flash', {
      code: 'WRITE_INDETERMINATE',
      boundary: 'operation',
      message: 'The durable write boundary was crossed; do not retry.',
      retryable: false,
      manualAction: 'do-not-retry-write',
    });
    const parsed = parseIpcReply('flash', failure);
    expect(parsed).toMatchObject({ ok: false, error: { operation: 'flash', code: 'WRITE_INDETERMINATE' } });
    if (parsed.ok) throw new Error('Fixture unexpectedly produced an IPC success');
    const error = new IpcContractError(parsed.error);
    expect(error).toMatchObject({
      name: 'IpcContractError',
      operation: 'flash',
      code: 'WRITE_INDETERMINATE',
      retryable: false,
      manualAction: 'do-not-retry-write',
    });
    expect(() => unwrapIpcReply('flash', failure)).toThrowError(expect.objectContaining({
      name: 'IpcContractError', code: 'WRITE_INDETERMINATE', boundary: 'operation',
    }));
  });

  it('normalizes malformed and version-skewed main replies into stable contract errors', () => {
    expect(() => unwrapIpcReply('capabilities', { protocolVersion: 99, ok: true, value: IPC_CAPABILITIES }))
      .toThrowError(expect.objectContaining({ code: 'IPC_PROTOCOL_MISMATCH', boundary: 'response', retryable: false }));
    expect(() => unwrapIpcReply('snapshot', { protocolVersion: IPC_PROTOCOL_VERSION, ok: true, value: {} }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE', boundary: 'response', retryable: false }));
    expect(unwrapIpcReply('capabilities', makeIpcSuccess('capabilities', IPC_CAPABILITIES))).toEqual(IPC_CAPABILITIES);
  });
});
