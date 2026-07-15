#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { extractFile, listPackage } from '@electron/asar';
import ts from 'typescript';
import { assertElectronFusePolicy } from './electron-fuse-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDirectory = join(root, 'release');
const projectPackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

if (process.platform !== 'darwin') throw new Error('The current packaged smoke target is macOS only');

const temporary = await mkdtemp(join(tmpdir(), 'tinysa-flasher-package-smoke-'));
try {
  const { dmg, zip } = await distributionContainers();
  await verifyDmg(dmg);

  const mountedInspection = await inspectDmgApplication(dmg, temporary);
  const extractedDirectory = join(temporary, 'extracted-zip');
  await mkdir(extractedDirectory, { recursive: true });
  const extraction = await run('/usr/bin/ditto', ['-x', '-k', zip, extractedDirectory], process.env, 60_000);
  if (extraction.code !== 0) throw new Error(`Could not extract ${basename(zip)}\n${extraction.stderr}`);

  const applications = await findApplications(extractedDirectory);
  if (applications.length !== 1) {
    throw new Error(`Expected exactly one .app in ${basename(zip)}, found ${applications.length}`);
  }
  const extractedInspection = await inspectApplication(applications[0]);
  assertMatchingApplicationIdentity(mountedInspection.identity, extractedInspection.identity, dmg, zip);
  await smokeApplication(extractedInspection, temporary, { dmg, zip });
} finally {
  await rm(temporary, { force: true, recursive: true });
}

async function inspectApplication(application) {
  const infoPlist = join(application, 'Contents', 'Info.plist');
  const identifier = await plistValue(infoPlist, 'CFBundleIdentifier');
  const shortVersion = await plistValue(infoPlist, 'CFBundleShortVersionString');
  const executableName = await plistValue(infoPlist, 'CFBundleExecutable');
  const minimumSystemVersion = await plistValue(infoPlist, 'LSMinimumSystemVersion');
  if (identifier !== projectPackage.build.appId) throw new Error(`Packaged identifier mismatch: ${identifier}`);
  if (shortVersion !== projectPackage.version) throw new Error(`Packaged version mismatch: ${shortVersion}`);
  if (minimumSystemVersion !== projectPackage.build.mac.minimumSystemVersion) {
    throw new Error(`Packaged macOS minimum mismatch: ${minimumSystemVersion}`);
  }
  const packagedInfo = await readPlist(infoPlist);
  const ats = packagedInfo.NSAppTransportSecurity;
  if (!isRecord(ats)
    || ats.NSAllowsArbitraryLoads !== false
    || ats.NSAllowsLocalNetworking !== false
    || Object.keys(ats).sort().join(',') !== 'NSAllowsArbitraryLoads,NSAllowsLocalNetworking') {
    throw new Error(`Packaged ATS policy is not exact: ${JSON.stringify(ats)}`);
  }
  for (const key of [
    'NSAudioCaptureUsageDescription',
    'NSBluetoothAlwaysUsageDescription',
    'NSBluetoothPeripheralUsageDescription',
    'NSCameraUsageDescription',
    'NSMicrophoneUsageDescription',
  ]) {
    if (Object.prototype.hasOwnProperty.call(packagedInfo, key)) {
      throw new Error(`Packaged Info.plist retained unused ${key}`);
    }
  }

  const executable = join(application, 'Contents', 'MacOS', executableName);
  await access(executable, constants.X_OK);
  const fuseStates = await assertElectronFusePolicy(application);
  const signature = await assertAdHocHardenedRuntime(application);
  if (signature.identifier !== identifier) {
    throw new Error(`Code-signing identifier ${signature.identifier} does not match bundle identifier ${identifier}`);
  }
  const archive = join(application, 'Contents', 'Resources', 'app.asar');
  await access(archive, constants.R_OK);
  const archiveFiles = new Set(listPackage(archive).map((path) => path.replace(/^\//, '')));
  for (const required of ['dist/main/main.js', 'dist/main/preload.cjs', 'dist/renderer/index.html', 'package.json']) {
    if (!archiveFiles.has(required)) throw new Error(`Packaged ASAR is missing ${required}`);
  }
  const preloadBundle = extractFile(archive, 'dist/main/preload.cjs').toString('utf8');
  assertPreloadRequires(preloadBundle);
  if ([...archiveFiles].some((path) => /(?:^|\/)(?:firmware-update-journal|firmware-write\.lock|preflight-|result-)/.test(path))) {
    throw new Error('Packaged ASAR contains runtime firmware evidence');
  }
  const packagedManifest = JSON.parse(extractFile(archive, 'package.json').toString('utf8'));
  if (packagedManifest.name !== projectPackage.name
    || packagedManifest.version !== projectPackage.version
    || packagedManifest.main !== projectPackage.main) {
    throw new Error('Packaged package.json does not match name, version, and main entry from the project manifest');
  }
  const rendererHtml = extractFile(archive, 'dist/renderer/index.html').toString('utf8');
  const cspMatch = /<meta\s+http-equiv=(["'])Content-Security-Policy\1\s+content=(["'])(.*?)\2/i.exec(rendererHtml);
  const contentSecurityPolicy = cspMatch?.[3];
  if (!contentSecurityPolicy
    || !/(?:^|;)\s*connect-src\s+'none'\s*(?:;|$)/.test(contentSecurityPolicy)
    || /\b(?:https?|wss?):/i.test(contentSecurityPolicy)
    || contentSecurityPolicy.includes('__TINysa_CONNECT_SOURCE__')) {
    throw new Error(`Packaged renderer CSP retains a network source or unresolved placeholder: ${String(contentSecurityPolicy)}`);
  }

  return {
    application,
    executable,
    fuseStates,
    signature,
    identity: {
      archiveSha256: await sha256File(archive),
      bundle: {
        identifier,
        shortVersion,
        executableName,
        minimumSystemVersion,
        appTransportSecurity: ats,
        asarIntegrity: packagedInfo.ElectronAsarIntegrity,
      },
      signature,
      fuseStates,
    },
  };
}

async function smokeApplication(inspection, temporaryDirectory, containers) {
  const userData = join(temporaryDirectory, 'user-data');
  const result = await run(inspection.executable, [`--user-data-dir=${userData}`], {
    ...process.env,
    HOME: temporaryDirectory,
    TMPDIR: temporaryDirectory,
    TINYSA_FLASHER_RUNTIME_SMOKE: '1',
    TINYSA_DFU_UTIL: '',
    VITE_DEV_SERVER_URL: '',
  });
  if (result.code !== 0) throw new Error(`Packaged runtime exited ${result.code}\n${result.stderr}`);
  const markerLine = result.stdout.split(/\r?\n/).find((line) => line.startsWith('TINYSA_FLASHER_RUNTIME_SMOKE_OK '));
  if (!markerLine) {
    throw new Error(`Packaged runtime did not emit its smoke marker\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  const marker = JSON.parse(markerLine.slice('TINYSA_FLASHER_RUNTIME_SMOKE_OK '.length));
  if (marker.packaged !== true
    || marker.name !== 'TinySA Flasher'
    || marker.version !== projectPackage.version
    || marker.electron !== projectPackage.devDependencies.electron
    || marker.rendererLoaded !== true
    || marker.preloadApi !== true) {
    throw new Error(`Unexpected packaged runtime identity: ${JSON.stringify(marker)}`);
  }
  try {
    await access(join(userData, 'firmware'));
    throw new Error('Runtime smoke unexpectedly created a firmware evidence directory');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  process.stdout.write(`Mounted and inspected ${basename(containers.dmg)}, extracted and ran ${basename(containers.zip)}, matched their packaged application identities, and passed ad-hoc hardened-runtime signing (${inspection.signature.flags.join(',')}), strict fuses ${JSON.stringify(inspection.fuseStates)}, manifest, preload, renderer, and isolated runtime smoke (${marker.architecture}, Electron ${marker.electron}).\n`);
}

async function distributionContainers() {
  const entries = await readdir(releaseDirectory, { withFileTypes: true });
  const dmgs = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.dmg')).map((entry) => join(releaseDirectory, entry.name));
  const zips = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.zip')).map((entry) => join(releaseDirectory, entry.name));
  if (dmgs.length !== 1 || zips.length !== 1) {
    throw new Error(`Expected exactly one DMG and one ZIP in release/, found ${dmgs.length} DMG and ${zips.length} ZIP`);
  }
  return { dmg: dmgs[0], zip: zips[0] };
}

async function verifyDmg(dmg) {
  const result = await run('/usr/bin/hdiutil', ['verify', dmg], process.env, 60_000);
  if (result.code !== 0) throw new Error(`hdiutil could not verify ${basename(dmg)}\n${result.stderr}`);
}

async function inspectDmgApplication(dmg, temporaryDirectory) {
  const mountPoint = join(temporaryDirectory, 'mounted-dmg');
  await mkdir(mountPoint);
  let attached = false;
  let inspection;
  let inspectionError;
  try {
    const attachment = await run('/usr/bin/hdiutil', [
      'attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, dmg,
    ], process.env, 60_000);
    if (attachment.code !== 0) throw new Error(`Could not mount ${basename(dmg)} read-only\n${attachment.stderr}`);
    attached = true;
    const applications = await findApplications(mountPoint);
    if (applications.length !== 1) {
      throw new Error(`Expected exactly one .app in ${basename(dmg)}, found ${applications.length}`);
    }
    inspection = await inspectApplication(applications[0]);
  } catch (error) {
    inspectionError = error;
  }

  let detachError;
  if (attached) {
    try {
      await detachDmg(mountPoint);
    } catch (error) {
      detachError = error;
    }
  }
  if (inspectionError && detachError) {
    throw new AggregateError([inspectionError, detachError], `Could not inspect and detach ${basename(dmg)}`);
  }
  if (inspectionError) throw inspectionError;
  if (detachError) throw detachError;
  return inspection;
}

async function detachDmg(mountPoint) {
  const detachment = await run('/usr/bin/hdiutil', ['detach', mountPoint], process.env, 60_000);
  if (detachment.code === 0) return;
  const forced = await run('/usr/bin/hdiutil', ['detach', '-force', mountPoint], process.env, 60_000);
  if (forced.code !== 0) {
    throw new Error(`Could not detach DMG mount ${mountPoint}\n${detachment.stderr}\n${forced.stderr}`);
  }
}

function assertMatchingApplicationIdentity(dmgIdentity, zipIdentity, dmg, zip) {
  if (JSON.stringify(dmgIdentity) !== JSON.stringify(zipIdentity)) {
    throw new Error(`${basename(dmg)} and ${basename(zip)} contain different packaged applications\nDMG: ${JSON.stringify(dmgIdentity)}\nZIP: ${JSON.stringify(zipIdentity)}`);
  }
}

async function findApplications(directory) {
  const found = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    if (entry.name.endsWith('.app')) found.push(path);
    else found.push(...await findApplications(path));
  }
  return found;
}

async function plistValue(plist, key) {
  const result = await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], process.env);
  if (result.code !== 0) throw new Error(`Could not read ${key} from ${plist}: ${result.stderr}`);
  return result.stdout.trim();
}

async function readPlist(plist) {
  const result = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], process.env);
  if (result.code !== 0) throw new Error(`Could not parse ${plist}: ${result.stderr}`);
  const value = JSON.parse(result.stdout);
  if (!isRecord(value)) throw new Error(`Expected a dictionary in ${plist}`);
  return value;
}

async function assertAdHocHardenedRuntime(application) {
  if (projectPackage.build.mac.identity !== '-' || projectPackage.build.mac.hardenedRuntime !== true) {
    throw new Error('Local packaging must explicitly use ad-hoc identity "-" with the hardened runtime enabled');
  }
  const verification = await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', application], process.env);
  if (verification.code !== 0) {
    throw new Error(`The ad-hoc application signature or nested code is invalid.\n${verification.stdout}\n${verification.stderr}`);
  }
  const result = await run('/usr/bin/codesign', ['-dv', '--verbose=4', application], process.env);
  const description = `${result.stdout}\n${result.stderr}`;
  const identifier = /^Identifier=(.+)$/m.exec(description)?.[1]?.trim();
  const cdHash = /^CDHash=([0-9a-f]+)$/mi.exec(description)?.[1]?.toLowerCase();
  const teamIdentifier = /^TeamIdentifier=(.+)$/m.exec(description)?.[1]?.trim();
  const signature = /^Signature=(.+)$/m.exec(description)?.[1]?.trim();
  const flags = /^CodeDirectory .* flags=0x[0-9a-f]+\(([^)]+)\)/m.exec(description)?.[1]
    ?.split(',').map((flag) => flag.trim()).filter(Boolean).sort() ?? [];
  if (/^Authority=/m.test(description)
    || (teamIdentifier && teamIdentifier !== 'not set')
    || (signature && signature !== 'adhoc')) {
    throw new Error(`The local/CI package unexpectedly has a Developer ID identity; use a separately reviewed public-release workflow.\n${description}`);
  }
  if (result.code !== 0
    || !identifier
    || !cdHash
    || signature !== 'adhoc'
    || !flags.includes('adhoc')
    || !flags.includes('runtime')) {
    throw new Error(`Could not establish an ad-hoc hardened-runtime package signature.\n${description}`);
  }
  return { identifier, cdHash, signature, teamIdentifier: teamIdentifier ?? 'not set', flags };
}

function assertPreloadRequires(source) {
  const sourceFile = ts.createSourceFile('dist/main/preload.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const specifiers = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      const [argument] = node.arguments;
      if (node.arguments.length !== 1 || !argument || !ts.isStringLiteralLike(argument)) {
        throw new Error('Sandboxed preload contains a dynamic or malformed require() call');
      }
      specifiers.push(argument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const unexpected = [...new Set(specifiers.filter((specifier) => specifier !== 'electron'))].sort();
  if (specifiers.length === 0 || unexpected.length > 0) {
    throw new Error(`Sandboxed preload runtime require allowlist mismatch: ${JSON.stringify([...new Set(specifiers)].sort())}; expected only ["electron"]`);
  }
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function run(command, args, environment, timeoutMs = 20_000) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const limit = 1024 * 1024;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-limit); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-limit); });
    child.once('error', rejectRun);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (signal) rejectRun(new Error(`${command} ended with ${signal}`));
      else resolveRun({ code: code ?? 1, stdout, stderr });
    });
  });
}
