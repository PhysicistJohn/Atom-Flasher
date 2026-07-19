'use strict';

const { app, dialog } = require('electron');
const { spawn } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { dirname, join } = require('node:path');
const { inspect } = require('node:util');
const { appendBoundedLogSync } = require('./bounded-log.cjs');
const { createDevelopmentHostEnvironment } = require('./launcher-environment.cjs');

const CONTRACT_VERSION = 1;
const configFile = join(__dirname, 'launcher-config.json');
const config = requireExactObject(
  JSON.parse(readFileSync(configFile, 'utf8')),
  ['contractVersion', 'appName', 'repoRoot', 'npmExecPath', 'nodeExecPath', 'iconFile'],
  'Installed launcher contract',
);
if (config.contractVersion !== CONTRACT_VERSION) {
  throw new Error(`Installed launcher contract version must be ${CONTRACT_VERSION}`);
}

const APP_NAME = config.appName;
const LOG_FILE = join(homedir(), 'Library', 'Logs', `${APP_NAME}.log`);
let devProcess;
let quitting = false;

mkdirSync(dirname(LOG_FILE), { recursive: true });

function requireExactObject(value, expectedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actualKeys = Object.keys(value).sort();
  const contractKeys = [...expectedKeys].sort();
  if (actualKeys.length !== contractKeys.length || actualKeys.some((key, index) => key !== contractKeys[index])) {
    throw new TypeError(`${label} keys must be exactly: ${contractKeys.join(', ')}`);
  }
  return value;
}

function formatLogValue(value) {
  const formatted = typeof value === 'string' ? value : inspect(value, { depth: 6, breakLength: 140 });
  const bytes = Buffer.from(formatted, 'utf8');
  if (bytes.length <= 8 * 1024) return formatted;
  return `${bytes.subarray(0, 8 * 1024).toString('utf8')}…[field truncated]`;
}

function log(level, ...values) {
  const line = `${new Date().toISOString()} [${level}] ${values.map(formatLogValue).join(' ')}\n`;
  appendBoundedLogSync(LOG_FILE, line);
}

function stopDevProcess() {
  if (!devProcess || devProcess.exitCode !== null || devProcess.killed) return;
  log('DEV', `Stopping development host pid=${devProcess.pid}`);
  devProcess.kill('SIGTERM');
}

function startDevProcess() {
  // This wrapper never rebuilds or launches the real application itself --
  // it exists only to give the Dock a correctly named, correctly iconed
  // entry point. The actual build/vite/Electron orchestration (and, for
  // Flasher, its careful never-signal-the-hardware-owning-process safety
  // logic) stays entirely inside each repo's own already-reviewed `npm run
  // dev`, invoked here as an ordinary child process.
  // A real node binary is required here, not this wrapper's own Electron
  // binary run via ELECTRON_RUN_AS_NODE=1 -- that env var would be inherited
  // by every descendant process, including the repo's own `electron .`
  // invocation further down the chain, silently forcing it into plain-Node
  // mode too and breaking it.
  devProcess = spawn(config.nodeExecPath, [config.npmExecPath, 'run', 'dev'], {
    cwd: config.repoRoot,
    env: createDevelopmentHostEnvironment(config.nodeExecPath),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  devProcess.stdout.on('data', (chunk) => appendBoundedLogSync(LOG_FILE, chunk));
  devProcess.stderr.on('data', (chunk) => appendBoundedLogSync(LOG_FILE, chunk));
  devProcess.on('error', (error) => log('ERROR', 'Development host process error', error));
  devProcess.once('exit', (code, signal) => {
    log('DEV', `Development host exited (code=${String(code)}, signal=${String(signal)})`);
    if (!quitting) app.quit();
  });
  log('DEV', `Starting pid=${devProcess.pid} cwd=${config.repoRoot}`);
}

function failLoudly(error) {
  const message = error instanceof Error ? error.message : formatLogValue(error);
  log('FATAL', error);
  dialog.showErrorBox(`${APP_NAME} failed to launch`, `${message}\n\nFull startup log:\n${LOG_FILE}`);
  process.exitCode = 1;
  app.quit();
}

app.setName(APP_NAME);
app.setPath('userData', join(app.getPath('appData'), APP_NAME));
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {});
  app.on('will-quit', () => {
    quitting = true;
    stopDevProcess();
  });
  process.on('uncaughtException', failLoudly);
  process.on('unhandledRejection', failLoudly);
  log('START', `\n${'='.repeat(72)}\nLaunching from ${process.resourcesPath}`);
  app.whenReady().then(() => {
    const icon = join(process.resourcesPath, config.iconFile);
    if (existsSync(icon)) app.dock.setIcon(icon);
    try {
      startDevProcess();
    } catch (error) {
      failLoudly(error);
    }
  }).catch(failLoudly);
}

process.on('exit', () => {
  if (!quitting) stopDevProcess();
});
