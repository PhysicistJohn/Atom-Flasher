import { lstat, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { preparePrivateDevelopmentDirectory } from '../tools/private-development-directory.mjs';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('private development evidence directory', () => {
  it('creates owner-only real directories inside the canonical repository root', async () => {
    const root = await temporaryDirectory();
    const userData = await preparePrivateDevelopmentDirectory(root);

    expect(userData).toBe(join(root, '.dev', 'user-data'));
    expect(Number((await lstat(join(root, '.dev'), { bigint: true })).mode & 0o777n)).toBe(0o700);
    expect(Number((await lstat(userData, { bigint: true })).mode & 0o777n)).toBe(0o700);
  });

  it('tightens an existing owner-controlled directory instead of leaving permissive modes', async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, '.dev'), { mode: 0o755 });
    await mkdir(join(root, '.dev', 'user-data'), { mode: 0o777 });

    const userData = await preparePrivateDevelopmentDirectory(root);
    expect(Number((await lstat(join(root, '.dev'), { bigint: true })).mode & 0o777n)).toBe(0o700);
    expect(Number((await lstat(userData, { bigint: true })).mode & 0o777n)).toBe(0o700);
  });

  it('refuses a symlink at either ignored path component', async () => {
    const rootWithLinkedDevelopment = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await symlink(outside, join(rootWithLinkedDevelopment, '.dev'));
    await expect(preparePrivateDevelopmentDirectory(rootWithLinkedDevelopment)).rejects.toThrow(/real directory/i);

    const rootWithLinkedUserData = await temporaryDirectory();
    await mkdir(join(rootWithLinkedUserData, '.dev'));
    await symlink(outside, join(rootWithLinkedUserData, '.dev', 'user-data'));
    await expect(preparePrivateDevelopmentDirectory(rootWithLinkedUserData)).rejects.toThrow(/real directory/i);
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'tinysa-private-dev-test-')));
  temporaryDirectories.push(path);
  return path;
}
