// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { initialFirmwareUpdateState, type DeviceSnapshot, type FirmwareUpdateState, type PortCandidate } from '../src/core/contracts.js';
import type { TinySaFlasherApi } from '../src/main/ipc-contract.js';
import { App } from '../src/renderer/App.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const exact: PortCandidate = { id: 'exact', path: '/dev/tty.exact', vendorId: '0483', productId: '5740', serialNumber: 'CDC407', usbMatch: 'exact-zs407-cdc' };
const rejected: PortCandidate = { id: 'other', path: '/dev/tty.other', vendorId: '1234', productId: '5678', usbMatch: 'unverified-serial' };

describe('standalone flasher renderer', () => {
  it('separates eligible and rejected serial devices before connection', async () => {
    installApi([exact, rejected], { connection: 'disconnected' }, initialFirmwareUpdateState());
    render(<App/>);
    expect(await screen.findByText('/dev/tty.exact')).toBeTruthy();
    expect(screen.getByText('/dev/tty.other')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Connect & verify' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('BLOCKED')).toBeTruthy();
  });

  it('offers no write when the exact connected device is already current', async () => {
    const connected = connectedSnapshot();
    const state: FirmwareUpdateState = {
      ...initialFirmwareUpdateState(),
      phase: 'up-to-date',
      current: { version: 'tinySA4_v1.4-224-gc979386', revision: 'c979386', sourceCommit: 'c97938697b6c7485e7cab50bca9af76996b7d671', qualification: 'supported-oem' },
    };
    installApi([exact], connected, state);
    render(<App/>);
    expect(await screen.findByText('Firmware is current')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Flash verified/i })).toBeNull();
  });

  it('shows a runtime serial fault and suppresses reconnect controls until safe disconnect is retried', async () => {
    installApi([exact], { connection: 'faulted', fault: 'RF output off remains unconfirmed' }, initialFirmwareUpdateState());
    render(<App/>);
    expect(await screen.findByRole('button', { name: 'Retry safe disconnect' })).toBeTruthy();
    expect(screen.getByText('RF output off remains unconfirmed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect & verify' })).toBeNull();
  });
});

function installApi(devices: readonly PortCandidate[], device: DeviceSnapshot, update: FirmwareUpdateState): void {
  const api: TinySaFlasherApi = {
    listDevices: vi.fn().mockResolvedValue(devices),
    deviceState: vi.fn().mockResolvedValue(device),
    connectDevice: vi.fn().mockResolvedValue(device),
    disconnectDevice: vi.fn().mockResolvedValue({ connection: 'disconnected' }),
    updateState: vi.fn().mockResolvedValue(update),
    download: vi.fn().mockResolvedValue(update),
    prepare: vi.fn().mockResolvedValue(update),
    detectDfu: vi.fn().mockResolvedValue(update),
    refreshPrerequisites: vi.fn().mockResolvedValue(update),
    flash: vi.fn().mockResolvedValue({ status: 'cancelled', state: update }),
  };
  Object.defineProperty(window, 'tinySaFlasher', { configurable: true, value: api });
}

function connectedSnapshot(): DeviceSnapshot {
  return {
    connection: 'ready',
    connectedAt: '2026-07-14T16:00:00.000Z',
    telemetry: { batteryMillivolts: 4211, deviceId: 407, capturedAt: '2026-07-14T16:00:00.000Z' },
    identity: {
      model: 'tinySA Ultra+ ZS407', hardwareVersion: 'V0.5.4 + ZS407', firmwareVersion: 'tinySA4_v1.4-224-gc979386',
      firmwareReportedRevision: 'c979386', firmwareSourceCommit: 'c97938697b6c7485e7cab50bca9af76996b7d671', firmwareQualification: 'supported-oem',
      port: exact, usbIdentityVerified: true,
    },
  };
}
