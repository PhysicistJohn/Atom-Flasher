'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { realpathSync } = require('node:fs');
const { delimiter, dirname } = require('node:path');
const { describe, it } = require('node:test');
const { createDevelopmentHostEnvironment } = require('./launcher-environment.cjs');

describe('development launcher environment', () => {
  it('prepends the configured Node directory to a Dock-style minimal PATH', () => {
    const nodeDirectory = dirname(process.execPath);
    const environment = createDevelopmentHostEnvironment(process.execPath, {
      HOME: '/tmp/launcher-home',
      PATH: `/usr/bin${delimiter}/bin${delimiter}${nodeDirectory}`,
      RETAINED: 'yes',
    });

    assert.deepEqual(environment.PATH.split(delimiter), [nodeDirectory, '/usr/bin', '/bin']);
    assert.equal(environment.HOME, '/tmp/launcher-home');
    assert.equal(environment.RETAINED, 'yes');
    assert.equal(environment.FORCE_COLOR, '0');
  });

  it('lets an npm-style lifecycle shell resolve the exact configured Node binary', () => {
    const environment = createDevelopmentHostEnvironment(process.execPath, { PATH: `/usr/bin${delimiter}/bin` });
    const result = spawnSync('/bin/sh', ['-c', 'node -p process.execPath'], { encoding: 'utf8', env: environment });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(realpathSync(result.stdout.trim()), realpathSync(process.execPath));
  });

  it('rejects a relative configured Node executable', () => {
    assert.throws(() => createDevelopmentHostEnvironment('node', {}), /absolute path/);
  });
});
