import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectFirmwareSafetyEvidence } from '../src/core/persistence/evidence-inspector.js';
import {
  COMPLETED_LEDGER_DIRECTORY,
  JOURNAL_FILENAME,
  WRITE_LOCK_FILENAME,
  completedLedgerFilename,
  preflightFilename,
  resultAuditFilename,
} from '../src/core/persistence/evidence-layout.js';
import {
  EVIDENCE_V1_FIRMWARE_RELEASE,
  type TransactionAuditV1,
} from '../src/core/persistence/evidence-schemas-v1.js';

const FIRST_ID = 'a5ada7f3-fbe3-41bd-83ac-a07028bc55f6';
const SECOND_ID = 'f6426f2c-195f-4db2-a234-dc388c65ff39';
const OWNER_ID = 'c42b1e0d-afb3-44e8-8f87-19a8bcf351f2';
const times = {
  artifact: '2026-07-14T11:58:00.000Z',
  telemetry: '2026-07-14T11:59:00.000Z',
  prepared: '2026-07-14T12:00:00.000Z',
  lock: '2026-07-14T12:00:30.000Z',
  started: '2026-07-14T12:01:00.000Z',
  writeComplete: '2026-07-14T12:02:00.000Z',
  verified: '2026-07-14T12:03:00.000Z',
  written: '2026-07-14T12:04:00.000Z',
} as const;

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe('durable firmware evidence linkage', () => {
  it.each(['prepared', 'started', 'completed'] as const)('accepts a complete legitimate %s history', async (stage) => {
    const directory = await temporary();
    await writeHistory(directory, FIRST_ID, stage);
    if (stage !== 'completed') await writeSyntheticCanonicalArtifact(directory);
    expect(await inspectFirmwareSafetyEvidence(directory, { verifyArtifact: verifySyntheticArtifact })).toEqual([]);
  });

  it('fails closed on missing and orphaned preflight/audit relationships', async () => {
    const missing = await temporary();
    await writeJson(join(missing, JOURNAL_FILENAME), journal(FIRST_ID, 'started'));
    const missingIssues = await inspectFirmwareSafetyEvidence(missing);
    expect(missingIssues).toEqual(expect.arrayContaining([
      expect.stringMatching(/canonical artifact.*missing/i),
      expect.stringMatching(/Missing preflight record.*active journal/i),
      expect.stringMatching(/Missing write-started audit.*active journal/i),
    ]));

    const orphaned = await temporary();
    await writeJson(join(orphaned, preflightFilename(FIRST_ID)), preflight(FIRST_ID));
    await writeJson(join(orphaned, resultAuditFilename(FIRST_ID, 'write-started')), audit(FIRST_ID, 'write-started'));
    const orphanIssues = await inspectFirmwareSafetyEvidence(orphaned);
    expect(orphanIssues).toEqual(expect.arrayContaining([
      expect.stringMatching(/Orphan preflight record/i),
      expect.stringMatching(/Orphan write-started audit/i),
    ]));
  });

  it('rejects cross-record preparation, timestamp, DFU, and device-ID inconsistencies', async () => {
    const directory = await temporary();
    const badPreflight = preflight(FIRST_ID);
    badPreflight.preparation.screenSha256 = 'b'.repeat(64);
    const badStarted = audit(FIRST_ID, 'write-started');
    if (badStarted.stage !== 'write-started') throw new Error('fixture stage mismatch');
    badStarted.value.dfuIdentity = dfuIdentity('OTHER-DFU');
    const badComplete = audit(FIRST_ID, 'write-complete');
    if (badComplete.stage !== 'write-complete') throw new Error('fixture stage mismatch');
    badComplete.value.writeCompletedAt = '2026-07-14T12:01:30.000Z';
    const badVerified = audit(FIRST_ID, 'verified-complete');
    if (badVerified.stage !== 'verified-complete') throw new Error('fixture stage mismatch');
    badVerified.value.deviceId = 999;

    await writeJson(join(directory, preflightFilename(FIRST_ID)), badPreflight);
    await writeJson(join(directory, resultAuditFilename(FIRST_ID, 'write-started')), badStarted);
    await writeJson(join(directory, resultAuditFilename(FIRST_ID, 'write-complete')), badComplete);
    await writeJson(join(directory, resultAuditFilename(FIRST_ID, 'verified-complete')), badVerified);
    await writeLedger(directory, journal(FIRST_ID, 'completed'));

    const issues = await inspectFirmwareSafetyEvidence(directory);
    expect(issues).toEqual(expect.arrayContaining([
      expect.stringMatching(/Preflight record.*does not match the preparation embedded/i),
      expect.stringMatching(/inconsistent DFU identities/i),
      expect.stringMatching(/Write-complete audit.*timestamp does not match/i),
      expect.stringMatching(/inconsistent write-completion timestamps/i),
      expect.stringMatching(/Verified-complete audit.*device ID does not match/i),
    ]));
  });

  it('rejects duplicate completed writes for the same physical device and historical target', async () => {
    const directory = await temporary();
    await writeHistory(directory, FIRST_ID, 'completed');
    await writeJson(join(directory, preflightFilename(SECOND_ID)), preflight(SECOND_ID));
    for (const stage of ['write-started', 'write-complete', 'verified-complete'] as const) {
      await writeJson(join(directory, resultAuditFilename(SECOND_ID, stage)), audit(SECOND_ID, stage));
    }
    await writeLedger(directory, journal(SECOND_ID, 'completed'));

    expect(await inspectFirmwareSafetyEvidence(directory)).toEqual(expect.arrayContaining([
      expect.stringMatching(/Duplicate completed writes.*device 407.*historical target/i),
    ]));
  });
});

async function writeHistory(directory: string, id: string, stage: 'prepared' | 'started' | 'completed'): Promise<void> {
  await writeJson(join(directory, preflightFilename(id)), preflight(id));
  if (stage === 'prepared') {
    await writeJson(join(directory, JOURNAL_FILENAME), journal(id, stage));
    return;
  }
  await writeJson(join(directory, resultAuditFilename(id, 'write-started')), audit(id, 'write-started'));
  if (stage === 'started') {
    await writeJson(join(directory, JOURNAL_FILENAME), journal(id, stage));
    await writeJson(join(directory, WRITE_LOCK_FILENAME), writeLock(id));
    return;
  }
  await writeJson(join(directory, resultAuditFilename(id, 'write-complete')), audit(id, 'write-complete'));
  await writeJson(join(directory, resultAuditFilename(id, 'verified-complete')), audit(id, 'verified-complete'));
  await writeLedger(directory, journal(id, stage));
}

async function writeLedger(directory: string, value: ReturnType<typeof journal>): Promise<void> {
  const ledger = join(directory, COMPLETED_LEDGER_DIRECTORY);
  await mkdir(ledger, { recursive: true });
  await writeJson(join(ledger, completedLedgerFilename(407, value.state.preparation.id)), value);
}

function journal(id: string, stage: 'prepared' | 'started' | 'completed') {
  const complete = stage === 'completed';
  const started = stage !== 'prepared';
  return {
    schemaVersion: 1 as const,
    targetVersion: EVIDENCE_V1_FIRMWARE_RELEASE.version,
    writtenAt: times.written,
    state: {
      phase: stage === 'prepared' ? 'awaiting-dfu' as const : stage === 'started' ? 'flashing' as const : 'completed' as const,
      target: EVIDENCE_V1_FIRMWARE_RELEASE,
      updateAvailable: !complete,
      ...(complete ? { current: currentFirmwareIdentity() } : {}),
      artifact: artifact(),
      dfuUtility: { available: true, version: '0.11' },
      dfuDevice: started
        ? { detected: true, count: 1, identity: dfuIdentity() }
        : { detected: false, count: 0 },
      preparation: preparation(id),
      writeDisposition: complete ? 'completed' as const : started ? 'started' as const : 'not-started' as const,
      ...(started ? {
        writeStartedAt: times.started,
        flashProgress: complete
          ? { stage: 'complete' as const, percent: 100, stagePercent: 100, updatedAt: times.verified }
          : { stage: 'preparing' as const, percent: 0, updatedAt: times.started },
      } : {}),
      ...(complete ? { writeCompletedAt: times.writeComplete, completedAt: times.verified } : {}),
    },
  };
}

function preflight(id: string) {
  return {
    schemaVersion: 1 as const,
    target: EVIDENCE_V1_FIRMWARE_RELEASE,
    preparation: preparation(id),
    identity: shippedFirmwareIdentity(),
    firmwareVersionResponse: 'tinySA4_v1.4-217-gc5dd31f',
    infoLines: ['tinySA ULTRA+ ZS407'],
    commands: ['version', 'info', 'help', 'mode', 'output', 'vbat', 'deviceid', 'capture'],
    telemetry: { batteryMillivolts: 4_100, deviceId: 407, capturedAt: times.telemetry },
    artifact: artifact(),
  };
}

function preparation(id: string) {
  return {
    id,
    preparedAt: times.prepared,
    batteryMillivolts: 4_100,
    deviceId: 407,
    screenSha256: 'a'.repeat(64),
    selfTestPassed: true as const,
    selfTestProcedure: 'tinySA4-zs407-cal-rf-v1' as const,
    configurationDisposition: 'new-device-unchanged' as const,
    rfPortsDisconnected: true as const,
    onlyUsbDeviceConnected: true as const,
    usbContinuity: {
      cdcPath: '/dev/tty.usbmodem407',
      cdcSerialNumber: 'CDC407',
      vendorId: '0483' as const,
      productId: '5740' as const,
      deviceId: 407,
    },
  };
}

function artifact() {
  return {
    sizeBytes: EVIDENCE_V1_FIRMWARE_RELEASE.sizeBytes,
    sha256: EVIDENCE_V1_FIRMWARE_RELEASE.sha256,
    verifiedAt: times.artifact,
  };
}

function audit(id: string, stage: 'write-started'): Extract<TransactionAuditV1, { stage: 'write-started' }>;
function audit(id: string, stage: 'write-complete'): Extract<TransactionAuditV1, { stage: 'write-complete' }>;
function audit(id: string, stage: 'verified-complete'): Extract<TransactionAuditV1, { stage: 'verified-complete' }>;
function audit(id: string, stage: TransactionAuditV1['stage']): TransactionAuditV1;
function audit(id: string, stage: TransactionAuditV1['stage']): TransactionAuditV1 {
  if (stage === 'write-started') {
    return {
      schemaVersion: 1,
      stage,
      target: EVIDENCE_V1_FIRMWARE_RELEASE,
      value: { preparationId: id, writeStartedAt: times.started, dfuIdentity: dfuIdentity() },
    };
  }
  if (stage === 'write-complete') {
    return {
      schemaVersion: 1,
      stage,
      target: EVIDENCE_V1_FIRMWARE_RELEASE,
      value: {
      preparationId: id,
      writeCompletedAt: times.writeComplete,
      dfuIdentity: dfuIdentity(),
      output: 'Download done. File downloaded successfully',
      outputTruncated: false,
      exceededExpectedDuration: false,
      },
    };
  }
  return {
    schemaVersion: 1,
    stage,
    target: EVIDENCE_V1_FIRMWARE_RELEASE,
    value: {
      preparationId: id,
      writeCompletedAt: times.writeComplete,
      completedAt: times.verified,
      identity: targetDeviceIdentity(),
      deviceId: 407,
    },
  };
}

function writeLock(id: string) {
  return {
    schemaVersion: 1 as const,
    purpose: 'firmware-write' as const,
    ownerToken: OWNER_ID,
    acquiredAt: times.lock,
    preparationId: id,
    dfuIdentity: dfuIdentity(),
  };
}

function dfuIdentity(serial = 'DFU407') {
  const identity = {
    path: '1-1',
    devnum: '5',
    serial,
    alt: 0 as const,
    name: '@Internal Flash /0x08000000/128*002Kg',
  };
  return {
    ...identity,
    fingerprint: JSON.stringify(identity),
    targetLine: `Found DFU: [0483:df11] devnum=5, path="1-1", alt=0, name="${identity.name}", serial="${serial}"`,
  };
}

function shippedFirmwareIdentity() {
  return {
    model: 'tinySA Ultra+ ZS407' as const,
    hardwareVersion: 'V0.5.4 + ZS407',
    firmwareVersion: 'tinySA4_v1.4-217-gc5dd31f' as const,
    firmwareReportedRevision: 'c5dd31f' as const,
    firmwareSourceCommit: 'c5dd31fd4679c15ba92ff46a6e258c1e3516ff0c' as const,
    firmwareQualification: 'supported-oem' as const,
    port: cdcPort(),
    usbIdentityVerified: true as const,
  };
}

function currentFirmwareIdentity() {
  return {
    version: EVIDENCE_V1_FIRMWARE_RELEASE.version,
    revision: EVIDENCE_V1_FIRMWARE_RELEASE.revision,
    sourceCommit: EVIDENCE_V1_FIRMWARE_RELEASE.sourceCommit,
    qualification: 'supported-oem' as const,
  };
}

function targetDeviceIdentity() {
  return {
    model: 'tinySA Ultra+ ZS407' as const,
    hardwareVersion: 'V0.5.4 + ZS407',
    firmwareVersion: EVIDENCE_V1_FIRMWARE_RELEASE.version,
    firmwareReportedRevision: EVIDENCE_V1_FIRMWARE_RELEASE.revision,
    firmwareSourceCommit: EVIDENCE_V1_FIRMWARE_RELEASE.sourceCommit,
    firmwareQualification: 'supported-oem' as const,
    port: cdcPort(),
    usbIdentityVerified: true as const,
  };
}

function cdcPort() {
  return {
    id: '/dev/tty.usbmodem407:CDC407:0483:5740',
    path: '/dev/tty.usbmodem407',
    serialNumber: 'CDC407',
    vendorId: '0483' as const,
    productId: '5740' as const,
    usbMatch: 'exact-zs407-cdc' as const,
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}

async function writeSyntheticCanonicalArtifact(directory: string): Promise<void> {
  await writeFile(
    join(directory, `${EVIDENCE_V1_FIRMWARE_RELEASE.version}.bin`),
    new Uint8Array(EVIDENCE_V1_FIRMWARE_RELEASE.sizeBytes),
  );
}

function verifySyntheticArtifact(bytes: Uint8Array): void {
  if (bytes.byteLength !== EVIDENCE_V1_FIRMWARE_RELEASE.sizeBytes) {
    throw new Error(`Synthetic artifact has ${bytes.byteLength} bytes`);
  }
}

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tinysa-evidence-linkage-'));
  directories.push(directory);
  return directory;
}
