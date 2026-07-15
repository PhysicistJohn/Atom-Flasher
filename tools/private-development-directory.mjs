import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

const PRIVATE_DIRECTORY_MODE = 0o700;

export async function preparePrivateDevelopmentDirectory(repositoryRoot) {
  const canonicalRoot = await realpath(repositoryRoot);
  const developmentRoot = join(canonicalRoot, '.dev');
  const developmentRootStatus = await ensurePrivateDirectory(developmentRoot);
  const userData = join(developmentRoot, 'user-data');
  await ensurePrivateDirectory(userData);
  await assertSameDirectory(developmentRoot, developmentRootStatus);
  return userData;
}

async function ensurePrivateDirectory(path) {
  try {
    await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const status = await lstat(path, { bigint: true });
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`Development evidence path must be a real directory, not a link or other entry: ${path}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && status.uid !== BigInt(uid)) {
    throw new Error(`Development evidence directory is not owned by the current user: ${path}`);
  }
  if (await realpath(path) !== path) {
    throw new Error(`Development evidence directory resolves through an unexpected path: ${path}`);
  }
  await chmod(path, PRIVATE_DIRECTORY_MODE);
  const hardened = await lstat(path, { bigint: true });
  if (!sameDirectory(status, hardened) || (hardened.mode & 0o777n) !== 0o700n) {
    throw new Error(`Development evidence directory changed while it was secured: ${path}`);
  }
  return hardened;
}

async function assertSameDirectory(path, expected) {
  const current = await lstat(path, { bigint: true });
  if (!sameDirectory(expected, current) || current.isSymbolicLink()) {
    throw new Error(`Development evidence root changed during setup: ${path}`);
  }
}

function sameDirectory(left, right) {
  return right.isDirectory()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid;
}
