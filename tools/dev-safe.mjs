#!/usr/bin/env node

import { spawn } from 'node:child_process';

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm run dev:safe must be launched through npm');

const child = spawn(process.execPath, [npmCli, 'run', 'dev:renderer'], {
  env: { ...process.env, VITE_SAFE_MOCK: '1' },
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => child.kill(signal));
}

child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
