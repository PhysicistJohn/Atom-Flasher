'use strict';

const { delimiter, dirname, isAbsolute } = require('node:path');

function createDevelopmentHostEnvironment(nodeExecPath, sourceEnvironment = process.env) {
  if (typeof nodeExecPath !== 'string' || !isAbsolute(nodeExecPath)) {
    throw new TypeError('Configured Node executable must be an absolute path');
  }
  if (!sourceEnvironment || typeof sourceEnvironment !== 'object' || Array.isArray(sourceEnvironment)) {
    throw new TypeError('Development host source environment must be an object');
  }

  const nodeDirectory = dirname(nodeExecPath);
  const inheritedPath = typeof sourceEnvironment.PATH === 'string' ? sourceEnvironment.PATH : '';
  const remainingEntries = inheritedPath
    .split(delimiter)
    .filter((entry) => entry && entry !== nodeDirectory);

  return {
    ...sourceEnvironment,
    PATH: [nodeDirectory, ...remainingEntries].join(delimiter),
    FORCE_COLOR: '0',
  };
}

module.exports = { createDevelopmentHostEnvironment };
