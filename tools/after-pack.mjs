#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { applyElectronFusePolicy } from './electron-fuse-policy.mjs';

const execFileAsync = promisify(execFile);
const plistBuddy = '/usr/libexec/PlistBuddy';
const plutil = '/usr/bin/plutil';
const unusedPermissionDescriptions = Object.freeze([
  'NSAudioCaptureUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription',
]);

export async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const application = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const infoPlist = join(application, 'Contents', 'Info.plist');
  const original = await readPlist(infoPlist);

  // electron-builder currently forces permissive localhost ATS values after it
  // merges mac.extendInfo. Recreate this dictionary in the final app, before
  // signing, so the packaged policy is exact and independently verifiable.
  if (hasOwn(original, 'NSAppTransportSecurity')) {
    await edit(infoPlist, 'Delete :NSAppTransportSecurity');
  }
  await edit(infoPlist, 'Add :NSAppTransportSecurity dict');
  await edit(infoPlist, 'Add :NSAppTransportSecurity:NSAllowsArbitraryLoads bool false');
  await edit(infoPlist, 'Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool false');

  for (const key of unusedPermissionDescriptions) {
    if (hasOwn(original, key)) await edit(infoPlist, `Delete :${key}`);
  }

  await execFileAsync(plutil, ['-lint', infoPlist], { encoding: 'utf8' });
  const hardened = await readPlist(infoPlist);
  const ats = hardened.NSAppTransportSecurity;
  if (!isRecord(ats)
    || ats.NSAllowsArbitraryLoads !== false
    || ats.NSAllowsLocalNetworking !== false
    || Object.keys(ats).sort().join(',') !== 'NSAllowsArbitraryLoads,NSAllowsLocalNetworking') {
    throw new Error(`Packaged ATS policy was not hardened exactly: ${JSON.stringify(ats)}`);
  }
  const retained = unusedPermissionDescriptions.filter((key) => hasOwn(hardened, key));
  if (retained.length > 0) throw new Error(`Packaged Info.plist retained unused permission descriptions: ${retained.join(', ')}`);

  // electron-builder signs the completed bundle immediately after afterPack.
  // Do not install an intermediate deep ad-hoc signature here: the builder's
  // inside-out signing pass must own every nested-code signature coherently.
  const fuses = await applyElectronFusePolicy(application, false);
  process.stdout.write(`Hardened packaged ATS, permission metadata, and Electron fuses for ${context.packager.appInfo.productFilename}.app: ${JSON.stringify(fuses)}.\n`);
}

async function edit(path, command) {
  await execFileAsync(plistBuddy, ['-c', command, path], { encoding: 'utf8' });
}

async function readPlist(path) {
  const { stdout } = await execFileAsync(plutil, ['-convert', 'json', '-o', '-', path], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  const value = JSON.parse(stdout);
  if (!isRecord(value)) throw new Error(`Expected a dictionary in ${path}`);
  return value;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
