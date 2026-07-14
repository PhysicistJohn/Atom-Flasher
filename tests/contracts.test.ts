import { describe, expect, it } from 'vitest';
import {
  OEM_ZS407_FIRMWARE_RELEASE,
  firmwareFlashRequestSchema,
  firmwareUpdatePreflightSchema,
  firmwareUpdateStateSchema,
  initialFirmwareUpdateState,
  portCandidateSchema,
} from '../src/core/contracts.js';

describe('standalone flasher contracts', () => {
  it('admits exact ZS407 USB identity and rejects a mislabeled candidate', () => {
    expect(portCandidateSchema.parse({ id: 'one', path: '/dev/tty.usb', vendorId: '0483', productId: '5740', usbMatch: 'exact-zs407-cdc' }).usbMatch).toBe('exact-zs407-cdc');
    expect(() => portCandidateSchema.parse({ id: 'bad', path: '/dev/tty.bad', vendorId: '1234', productId: '5740', usbMatch: 'exact-zs407-cdc' })).toThrow(/0483:5740/);
  });

  it('requires every human preflight attestation', () => {
    const valid = {
      selfTestPassed: true,
      selfTestProcedure: 'tinySA4-zs407-cal-rf-v1',
      configurationDisposition: 'new-device-unchanged',
      rfPortsDisconnected: true,
      onlyUsbDeviceConnected: true,
    };
    expect(firmwareUpdatePreflightSchema.safeParse(valid).success).toBe(true);
    expect(firmwareUpdatePreflightSchema.safeParse({ ...valid, onlyUsbDeviceConnected: false }).success).toBe(false);
    expect(firmwareUpdatePreflightSchema.safeParse({ ...valid, rfPortsDisconnected: false }).success).toBe(false);
  });

  it('keeps the flash confirmation literal out of renderer discretion', () => {
    const preparationId = 'a5ada7f3-fbe3-41bd-83ac-a07028bc55f6';
    expect(firmwareFlashRequestSchema.safeParse({ preparationId, confirmation: 'FLASH VERIFIED OEM FIRMWARE' }).success).toBe(true);
    expect(firmwareFlashRequestSchema.safeParse({ preparationId, confirmation: 'yes' }).success).toBe(false);
  });

  it('rejects ready-to-flash state without one persisted DFU identity', () => {
    const state = { ...initialFirmwareUpdateState(), phase: 'ready-to-flash', updateAvailable: true, dfuDevice: { detected: true, count: 1 } };
    expect(firmwareUpdateStateSchema.safeParse(state).success).toBe(false);
  });

  it.each([
    'tinySA4_custom-gc979386',
    'tinySA4_v1.4-224-gc979386-dirty',
  ])('cannot persist spoofed version %s as supported OEM provenance', (version) => {
    const state = {
      ...initialFirmwareUpdateState(),
      current: {
        version,
        revision: OEM_ZS407_FIRMWARE_RELEASE.revision,
        sourceCommit: OEM_ZS407_FIRMWARE_RELEASE.sourceCommit,
        qualification: 'supported-oem',
      },
    };
    expect(firmwareUpdateStateSchema.safeParse(state).success).toBe(false);
  });

  it('pins the immutable release metadata', () => {
    expect(OEM_ZS407_FIRMWARE_RELEASE).toMatchObject({
      revision: 'c979386',
      sizeBytes: 185_704,
      sha256: '3c9847ff4d7b80561df2f2f1030a112703a083409ffb2ee11361b2413b7c1e41',
    });
  });
});
