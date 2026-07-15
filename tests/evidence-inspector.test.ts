import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initialFirmwareUpdateState, OEM_ZS407_FIRMWARE_TARGET } from '../src/core/contracts.js';
import { firmwareTargetV2Sha256 } from '../src/core/persistence/evidence-schemas-v2.js';

const temporaryDirectories: string[] = [];
const inspector = resolve('tools/inspect-evidence.mjs');

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('read-only evidence inspector', () => {
  it('inventories nested evidence, hashes files, and reports write hazards', async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, 'completed-ledger-v1', 'archive', '2026'), { recursive: true });
    await writeFile(join(root, 'firmware-update-journal-v1.json'), JSON.stringify({
      schemaVersion: 1,
      targetVersion: 'target',
      writtenAt: '2026-07-14T16:00:00.000Z',
      state: { phase: 'failed', writeDisposition: 'indeterminate' },
    }));
    await writeFile(join(root, 'firmware-write.lock'), 'owner-token');
    await writeFile(join(root, 'completed-ledger-v1', 'archive', '2026', 'completed.json'), JSON.stringify({ schemaVersion: 1, completedAt: '2026-07-14T16:01:00.000Z' }));
    await symlink(join(root, 'firmware-update-journal-v1.json'), join(root, 'ignored-link'));

    const result = await runInspector(['--path', root, '--json']);
    expect(result.code).toBe(2);
    const report = JSON.parse(result.stdout) as {
      counts: { activeJournals: number; completedLedgers: number; locks: number };
      hazards: string[];
      warnings: string[];
      evidence: Array<{ kind: string; sha256: string; json?: { writeDisposition?: string } }>;
    };
    expect(report.counts).toMatchObject({ activeJournals: 1, completedLedgers: 1, locks: 1 });
    expect(report.evidence.every((item) => /^[a-f0-9]{64}$/.test(item.sha256))).toBe(true);
    expect(report.evidence.find((item) => item.kind === 'active-journal')?.json?.writeDisposition).toBe('indeterminate');
    expect(report.hazards.join('\n')).toContain('do not retry');
    expect(report.warnings).toContain('Skipped symbolic link: ignored-link');
  });

  it('reports an absent default-shaped path without creating it', async () => {
    const parent = await temporaryDirectory();
    const absent = join(parent, 'does-not-exist');
    const result = await runInspector(['--path', absent, '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ inspectedPath: absent, exists: false });
  });

  it('fails closed for a parseable but structurally invalid active journal', async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, 'firmware-update-journal-v2.json'), '{}');

    const result = await runInspector(['--path', root, '--json']);
    expect(result.code).toBe(2);
    const report = JSON.parse(result.stdout) as { hazards: string[] };
    expect(report.hazards.join('\n')).toMatch(/active journal is structurally invalid.*schemaVersion/i);
  });

  it('allows only a fully schema-valid not-started active journal', async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, 'firmware-update-journal-v2.json'), JSON.stringify({
      schemaVersion: 2,
      targetId: OEM_ZS407_FIRMWARE_TARGET.targetId,
      targetSha256: firmwareTargetV2Sha256(OEM_ZS407_FIRMWARE_TARGET),
      writtenAt: '2026-07-14T16:00:00.000Z',
      state: initialFirmwareUpdateState(),
    }));

    const result = await runInspector(['--path', root, '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ hazards: [], counts: { activeJournals: 1 } });
  });

  it('fails closed when journal fields contradict a not-started disposition', async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, 'firmware-update-journal-v2.json'), JSON.stringify({
      schemaVersion: 2,
      targetId: OEM_ZS407_FIRMWARE_TARGET.targetId,
      targetSha256: firmwareTargetV2Sha256(OEM_ZS407_FIRMWARE_TARGET),
      writtenAt: '2026-07-14T16:00:00.000Z',
      state: {
        ...initialFirmwareUpdateState(),
        phase: 'flashing',
        writeDisposition: 'not-started',
        writeStartedAt: '2026-07-14T15:59:00.000Z',
      },
    }));

    const result = await runInspector(['--path', root, '--json']);
    expect(result.code).toBe(2);
    const report = JSON.parse(result.stdout) as { hazards: string[] };
    expect(report.hazards.join('\n')).toMatch(/active journal is structurally invalid/i);
  });

  it('refuses an ancestor symbolic link instead of inspecting its target', async () => {
    const parent = await temporaryDirectory();
    await mkdir(join(parent, 'actual', 'firmware'), { recursive: true });
    await writeFile(join(parent, 'actual', 'firmware', 'firmware-update-journal-v2.json'), '{}');
    await symlink(join(parent, 'actual'), join(parent, 'linked-parent'));

    const requested = join(parent, 'linked-parent', 'firmware');
    const result = await runInspector(['--path', requested, '--json']);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      inspectedPath: requested,
      exists: true,
      counts: { files: 0 },
      evidence: [],
      hazards: [expect.stringMatching(/symbolic-link component/i)],
    });
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'tinysa-evidence-inspector-test-')));
  temporaryDirectories.push(path);
  return path;
}

function runInspector(arguments_: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [inspector, ...arguments_], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', rejectRun);
    child.once('close', (code, signal) => {
      if (signal) rejectRun(new Error(`Inspector ended with ${signal}`));
      else resolveRun({ code: code ?? 1, stdout, stderr });
    });
  });
}
