'use strict';

const {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} = require('node:fs');

const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_APPEND_BYTES = 64 * 1024;
const TRUNCATION_MARKER = Buffer.from('[older bytes in this write were truncated]\n', 'utf8');

/**
 * Synchronously appends one bounded diagnostic chunk and keeps at most one
 * bounded rotation. Synchronous writes are intentional for crash diagnostics;
 * their latency and retained disk footprint are bounded by this admission
 * layer instead of growing with the age of the development installation.
 */
function appendBoundedLogSync(file, value, options = {}) {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxAppendBytes = options.maxAppendBytes ?? DEFAULT_MAX_APPEND_BYTES;
  requirePositiveSafeInteger(maxFileBytes, 'maxFileBytes');
  requirePositiveSafeInteger(maxAppendBytes, 'maxAppendBytes');
  if (maxAppendBytes > maxFileBytes) throw new RangeError('maxAppendBytes cannot exceed maxFileBytes');
  if (maxAppendBytes < TRUNCATION_MARKER.length) {
    throw new RangeError(`maxAppendBytes must be at least ${TRUNCATION_MARKER.length}`);
  }

  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  const admitted = bytes.length <= maxAppendBytes
    ? bytes
    : Buffer.concat([
      TRUNCATION_MARKER,
      utf8Tail(bytes, maxAppendBytes - TRUNCATION_MARKER.length),
    ]);
  const backup = `${file}.1`;
  normalizeBackup(backup, maxFileBytes);

  let existing;
  try { existing = lstatSync(file); }
  catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  if (existing) {
    const metadata = existing;
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
      throw new Error(`Development log must be a regular non-symlink file: ${file}`);
    }
    if (metadata.size > maxFileBytes) {
      // A legacy unbounded log must not become an equally unbounded rotation.
      unlinkSync(file);
    } else if (metadata.size + admitted.length > maxFileBytes) {
      // normalizeBackup admitted only one bounded regular file here.
      try { unlinkSync(backup); }
      catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
      renameSync(file, backup);
    }
  }

  // O_NOFOLLOW closes the lstat/open replacement race and also rejects a
  // dangling symlink, which existsSync deliberately reports as absent.
  const descriptor = openSync(
    file,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.nlink !== 1) throw new Error(`Development log must be a regular single-link file: ${file}`);
    let offset = 0;
    while (offset < admitted.length) offset += writeSync(descriptor, admitted, offset);
  } finally {
    closeSync(descriptor);
  }
}

function normalizeBackup(backup, maxFileBytes) {
  let metadata;
  try { metadata = lstatSync(backup); }
  catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  if (metadata.isDirectory()) {
    throw new Error(`Development log rotation must not be a directory: ${backup}`);
  }
  // Unlinking a symlink, special file, or extra hard-link name never follows
  // it. This restores the launcher's two-regular-file retention invariant
  // without modifying an out-of-bound target.
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1 || metadata.size > maxFileBytes) {
    unlinkSync(backup);
  }
}

function utf8Tail(bytes, maximumBytes) {
  let start = Math.max(0, bytes.length - maximumBytes);
  // A String-derived buffer is valid UTF-8. Advancing past continuation bytes
  // keeps the retained suffix valid instead of beginning inside a code point.
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start);
}

function requirePositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive safe integer`);
}

module.exports = {
  appendBoundedLogSync,
  DEFAULT_MAX_APPEND_BYTES,
  DEFAULT_MAX_FILE_BYTES,
};
