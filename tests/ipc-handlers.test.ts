import { describe, expect, it, vi } from 'vitest';
import { IPC, IPC_CAPABILITIES } from '../src/main/ipc-contract.js';
import {
  classifyIpcFailure,
  createContractedHandler,
  registerApplicationIpc,
  type ApplicationIpcPort,
  type IpcRegistrar,
} from '../src/main/ipc-handlers.js';

function applicationWithDisposition(writeDisposition = 'not-started'): ApplicationIpcPort {
  return {
    snapshot: () => ({ update: { writeDisposition } }),
  } as unknown as ApplicationIpcPort;
}

describe('main IPC adapter boundary', () => {
  it('registers and removes exactly one independently consumable handler per contract', async () => {
    const handlers = new Map<string, (event: { trusted: boolean }, ...args: unknown[]) => Promise<unknown>>();
    const removed: string[] = [];
    const registrar: IpcRegistrar<{ trusted: boolean }> = {
      handle: vi.fn((channel, listener) => { handlers.set(channel, listener); }),
      removeHandler: vi.fn((channel) => { handlers.delete(channel); removed.push(channel); }),
    };
    const application = {
      snapshot: vi.fn(),
      scanDevices: vi.fn(),
      connectDevice: vi.fn(),
      disconnectDevice: vi.fn(),
      recoverDevice: vi.fn(),
      download: vi.fn(),
      prepare: vi.fn(),
      detectDfu: vi.fn(),
      refreshPrerequisites: vi.fn(),
      flash: vi.fn(),
    } as unknown as ApplicationIpcPort;

    const remove = registerApplicationIpc({ registrar, application, isTrusted: (event) => event.trusted });
    expect([...handlers.keys()]).toEqual(Object.values(IPC));
    const capabilities = await handlers.get(IPC.capabilities)?.({ trusted: true });
    expect(capabilities).toMatchObject({ ok: true, value: IPC_CAPABILITIES });

    remove();
    expect(handlers.size).toBe(0);
    expect(removed).toEqual(Object.values(IPC));
  });

  it('rejects untrusted senders before parsing or invoking the operation', async () => {
    const operation = vi.fn(async () => IPC_CAPABILITIES);
    const handler = createContractedHandler('capabilities', operation, {
      application: applicationWithDisposition(),
      isTrusted: () => false,
    });
    await expect(handler({})).rejects.toThrow(/untrusted renderer/i);
    expect(operation).not.toHaveBeenCalled();
  });

  it('returns stable request and response-boundary failures', async () => {
    const operation = vi.fn(async () => IPC_CAPABILITIES);
    const requestHandler = createContractedHandler('capabilities', operation, {
      application: applicationWithDisposition(),
      isTrusted: () => true,
    });
    const invalidRequest = await requestHandler({}, 'unexpected');
    expect(invalidRequest).toMatchObject({
      ok: false,
      error: { operation: 'capabilities', code: 'INVALID_REQUEST', boundary: 'request', retryable: false },
    });
    expect(operation).not.toHaveBeenCalled();

    const responseHandler = createContractedHandler('snapshot', async () => ({ malformed: true }) as never, {
      application: applicationWithDisposition(),
      isTrusted: () => true,
    });
    const invalidResponse = await responseHandler({});
    expect(invalidResponse).toMatchObject({
      ok: false,
      error: { operation: 'snapshot', code: 'INVALID_RESPONSE', boundary: 'response', retryable: false },
    });
  });

  it('uses post-failure durable disposition to prohibit any repeated update mutation', async () => {
    const handler = createContractedHandler('detectDfu', async () => {
      throw new Error('DFU enumeration failed');
    }, {
      application: applicationWithDisposition('indeterminate'),
      isTrusted: () => true,
    });
    const reply = await handler({});
    expect(reply).toMatchObject({
      ok: false,
      error: {
        code: 'WRITE_INDETERMINATE',
        boundary: 'operation',
        retryable: false,
        manualAction: 'do-not-retry-write',
      },
    });
  });
});

describe('IPC operation failure classification', () => {
  it('makes durable write and evidence ambiguity nonretryable across update operations', () => {
    expect(classifyIpcFailure('prepare', new Error('preflight failed'), 'started')).toEqual({
      code: 'WRITE_INDETERMINATE', retryable: false, manualAction: 'do-not-retry-write',
    });
    expect(classifyIpcFailure('refreshPrerequisites', new Error('journal lock is owned by another process'), 'not-started')).toEqual({
      code: 'EVIDENCE_INDETERMINATE', retryable: false, manualAction: 'inspect-safety-evidence',
    });
    expect(classifyIpcFailure('download', new Error('write attempt already exists'), undefined)).toEqual({
      code: 'EVIDENCE_INDETERMINATE', retryable: false, manualAction: 'inspect-safety-evidence',
    });
  });

  it('keeps pre-write transient admission failures decomposed by recovery action', () => {
    expect(classifyIpcFailure('download', new Error('HTTP source unavailable'), 'not-started')).toEqual({
      code: 'FIRMWARE_SOURCE_FAILED', retryable: true, manualAction: 'none',
    });
    expect(classifyIpcFailure('prepare', new Error('Application policy does not allow prepare-firmware in the current state'), 'not-started')).toEqual({
      code: 'UPDATE_PRECONDITION_FAILED', retryable: true, manualAction: 'none',
    });
    expect(classifyIpcFailure('flash', new Error('exact DFU target identity changed'), 'not-started')).toEqual({
      code: 'DFU_ADMISSION_FAILED', retryable: true, manualAction: 'none',
    });
    expect(classifyIpcFailure('disconnectDevice', new Error('RF output is unconfirmed'))).toEqual({
      code: 'DEVICE_SAFETY_FAULT', retryable: false, manualAction: 'power-off-device',
    });
    expect(classifyIpcFailure('scanDevices', new Error('download-firmware is already active'))).toEqual({
      code: 'OPERATION_BUSY', retryable: true, manualAction: 'none',
    });
  });
});
