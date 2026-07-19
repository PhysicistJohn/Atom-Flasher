#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { preparePrivateDevelopmentDirectory } from './private-development-directory.mjs';

const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm run dev must be launched through npm so the pinned npm CLI is known');

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const rendererUrl = 'http://127.0.0.1:5175/';
const developmentHostLifetimeDescriptor = 3;
const developerData = await preparePrivateDevelopmentDirectory(root);
const watchedInputs = [
  ...['src/application', 'src/core', 'src/device', 'src/dfu', 'src/main']
    .map((path) => ({ directory: join(root, path), matches: /\.(?:ts|tsx)$/ })),
  { directory: join(root, 'contracts/releases'), matches: /\.json$/ },
];

let stopping = false;
let viteProcess;
let electronProcess;
let electronLifetimeChannel;
let buildProcess;
let rebuilding = false;
let rebuildPending = false;
let restartPending = false;
let restartTimer;
const watchers = [];

viteProcess = runNpm(['run', 'dev:renderer']);
viteProcess.once('exit', (code, signal) => {
  if (stopping) return;
  process.stderr.write(`Renderer server stopped unexpectedly (${signal ?? `exit ${code ?? 'unknown'}`}).\n`);
  void shutdown(code ?? 1);
});

try {
  await Promise.all([buildMain(), waitForRenderer()]);
  if (viteProcess.exitCode !== null) throw new Error('The renderer server exited during startup');
  await startElectron();
  startWatchers();
  process.stdout.write('\nLive development is ready. Renderer changes use HMR; application, main, preload, core, device, DFU, and active release-manifest changes rebuild and stage a safe Electron restart.\n');
  process.stdout.write(`Development evidence is isolated under ${developerData}\n\n`);
} catch (error) {
  process.stderr.write(`${formatError(error)}\n`);
  await shutdown(1);
}

process.once('SIGINT', () => { void shutdown(0); });
process.once('SIGTERM', () => { void shutdown(0); });

function runNpm(args) {
  return spawn(process.execPath, [npmCli, ...args], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
}

async function buildMain() {
  buildProcess = runNpm(['run', 'build:main']);
  const result = await waitForExit(buildProcess);
  buildProcess = undefined;
  if (result.code !== 0) throw new Error(`Main/preload build failed (${result.signal ?? `exit ${result.code}`})`);
}

async function waitForRenderer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (viteProcess?.exitCode !== null) throw new Error('The renderer server exited before becoming ready');
    try {
      const response = await fetch(rendererUrl, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        await delay(300);
        return;
      }
    } catch {
      // Vite is still starting.
    }
    await delay(100);
  }
  throw new Error(`Renderer server did not become ready at ${rendererUrl}`);
}

async function startElectron() {
  if (stopping) return;
  const child = spawn(electronBinary, [root, `--user-data-dir=${developerData}`], {
    cwd: root,
    // A terminal SIGINT/SIGTERM sent to the development host must not also
    // terminate a hardware-capable Electron process. On macOS, a detached
    // child leads a separate process group while remaining observable here.
    detached: true,
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: rendererUrl,
      TINYSA_FLASHER_DEV_USER_DATA: developerData,
      TINYSA_FLASHER_DEV_HOST_LIFETIME_FD: String(developmentHostLifetimeDescriptor),
    },
    // fd 3 is a payload-free lifetime channel. Electron observes EOF when this
    // host exits for any reason, including SIGKILL, and permanently revokes
    // the development renderer before another process can claim the origin.
    stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
  });
  const lifetimeChannel = child.stdio[developmentHostLifetimeDescriptor];
  lifetimeChannel?.unref?.();
  electronLifetimeChannel = lifetimeChannel;
  electronProcess = child;
  child.once('exit', (code, signal) => {
    if (electronProcess === child) {
      electronProcess = undefined;
      electronLifetimeChannel = undefined;
    }
    if (stopping) return;
    if (restartPending && !rebuilding) {
      restartPending = false;
      void startElectron();
      return;
    }
    process.stderr.write(`Electron stopped (${signal ?? `exit ${code ?? 'unknown'}`}); it will start again after the next successful main-process build.\n`);
  });
}

function startWatchers() {
  for (const { directory, matches } of watchedInputs) {
    const watcher = watch(directory, { recursive: true }, (_event, filename) => {
      if (!filename || !matches.test(filename)) return;
      scheduleRebuild();
    });
    watchers.push(watcher);
  }
}

function scheduleRebuild() {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => { void rebuildAndRestart(); }, 120);
}

async function rebuildAndRestart() {
  if (stopping) return;
  if (rebuilding) {
    rebuildPending = true;
    return;
  }
  rebuilding = true;
  restartPending = false;
  process.stdout.write('\nRebuilding Electron main/preload…\n');
  try {
    await buildMain();
    if (electronProcess && electronProcess.exitCode === null && electronProcess.signalCode === null) {
      restartPending = true;
      process.stdout.write('Updated main/preload build is ready. Quit Flasher normally when safe; the development host will then restart it.\n');
    } else {
      await startElectron();
    }
  } catch (error) {
    process.stderr.write(`${formatError(error)}\nThe last successful Electron process remains available when possible.\n`);
  } finally {
    rebuilding = false;
    if (rebuildPending) {
      rebuildPending = false;
      scheduleRebuild();
    }
  }
}

async function shutdown(exitCode) {
  if (stopping) return;
  stopping = true;
  clearTimeout(restartTimer);
  for (const watcher of watchers) watcher.close();

  // Never signal Electron from the development host. Its main process owns
  // the no-quit firmware safety boundary and must complete a normal, locally
  // approved shutdown. unref() lets this wrapper stop without weakening that
  // boundary; the developer then quits the still-running app when it is safe.
  if (electronProcess && electronProcess.exitCode === null && electronProcess.signalCode === null) {
    // Revoke renderer authority before stopping Vite and releasing its trusted
    // loopback port. SIGKILL needs no cleanup: the kernel closes this endpoint.
    electronLifetimeChannel?.destroy();
    electronLifetimeChannel = undefined;
    process.stdout.write('\nDevelopment host stopped without terminating Flasher. Its inherited lifetime channel will revoke and close the renderer while any in-flight main-process update finishes safely. Quit the quarantined app normally when its safety state permits.\n');
    electronProcess.unref();
  }
  await Promise.allSettled([
    stopChild(buildProcess),
    stopChild(viteProcess),
  ]);
  process.exitCode = exitCode;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const finished = waitForExit(child);
  const timeout = delay(3_000).then(() => 'timeout');
  if (await Promise.race([finished.then(() => 'finished'), timeout]) === 'timeout') {
    child.kill('SIGKILL');
    await finished;
  }
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode ?? 1, signal: child.signalCode });
  }
  return new Promise((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code: code ?? (signal ? 1 : 0), signal }));
  });
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function formatError(value) {
  return value instanceof Error ? value.stack ?? value.message : String(value);
}
