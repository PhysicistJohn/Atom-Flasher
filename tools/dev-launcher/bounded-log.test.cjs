'use strict';

const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { appendBoundedLogSync } = require('./bounded-log.cjs');

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('bounded development launcher log', () => {
  it('caps the current file and its sole rotation across an indefinite append sequence', () => {
    const file = temporaryLog();
    for (let index = 0; index < 1_000; index++) {
      appendBoundedLogSync(file, `${String(index).padStart(4, '0')}:${'x'.repeat(43)}\n`, {
        maxFileBytes: 256,
        maxAppendBytes: 128,
      });
    }

    assert.ok(statSync(file).size <= 256);
    assert.ok(statSync(`${file}.1`).size <= 256);
  });

  it('retains only a marked bounded tail from one oversized process-output write', () => {
    const file = temporaryLog();
    appendBoundedLogSync(file, `prefix-${'y'.repeat(2_000)}-newest`, {
      maxFileBytes: 256,
      maxAppendBytes: 128,
    });

    const retained = readFileSync(file, 'utf8');
    assert.equal(Buffer.byteLength(retained), 128);
    assert.match(retained, /older bytes in this write were truncated/);
    assert.match(retained, /-newest/);
    assert.doesNotMatch(retained, /prefix-/);
  });

  it('discards an oversized legacy file instead of preserving it as an oversized rotation', () => {
    const file = temporaryLog();
    writeFileSync(file, 'z'.repeat(1_024));

    appendBoundedLogSync(file, 'fresh\n', { maxFileBytes: 256, maxAppendBytes: 128 });

    assert.equal(readFileSync(file, 'utf8'), 'fresh\n');
    assert.throws(() => statSync(`${file}.1`));
  });

  it('rejects a dangling log symlink instead of following it on creation', () => {
    const file = temporaryLog();
    const target = `${file}.redirected`;
    symlinkSync(target, file);

    assert.throws(
      () => appendBoundedLogSync(file, 'must not escape\n', { maxFileBytes: 256, maxAppendBytes: 128 }),
      /regular non-symlink file/,
    );
    assert.equal(existsSync(target), false);
  });

  it('retains valid UTF-8 when an oversized append is cut through multibyte text', () => {
    const file = temporaryLog();
    appendBoundedLogSync(file, `old-${'🧪'.repeat(100)}-new`, {
      maxFileBytes: 128,
      maxAppendBytes: 64,
    });

    const retained = readFileSync(file);
    const decoded = retained.toString('utf8');
    assert.equal(Buffer.from(decoded, 'utf8').equals(retained), true);
    assert.match(decoded, /-new$/);
  });

  it('rejects a hard-linked current log instead of modifying its other name', () => {
    const file = temporaryLog();
    const target = `${file}.target`;
    writeFileSync(target, 'sensitive\n');
    linkSync(target, file);

    assert.throws(
      () => appendBoundedLogSync(file, 'must not append\n', { maxFileBytes: 256, maxAppendBytes: 128 }),
      /regular non-symlink file/,
    );
    assert.equal(readFileSync(target, 'utf8'), 'sensitive\n');
  });

  it('removes an oversized legacy rotation even when the current append does not rotate', () => {
    const file = temporaryLog();
    writeFileSync(file, 'current\n');
    writeFileSync(`${file}.1`, 'z'.repeat(1_024));

    appendBoundedLogSync(file, 'fresh\n', { maxFileBytes: 256, maxAppendBytes: 128 });

    assert.equal(readFileSync(file, 'utf8'), 'current\nfresh\n');
    assert.equal(existsSync(`${file}.1`), false);
  });

  it('unlinks a non-regular legacy rotation without following its target', () => {
    const file = temporaryLog();
    const target = `${file}.outside`;
    writeFileSync(file, 'current\n');
    writeFileSync(target, 'outside\n');
    symlinkSync(target, `${file}.1`);

    appendBoundedLogSync(file, 'fresh\n', { maxFileBytes: 256, maxAppendBytes: 128 });

    assert.equal(existsSync(`${file}.1`), false);
    assert.equal(readFileSync(target, 'utf8'), 'outside\n');
  });
});

function temporaryLog() {
  const root = mkdtempSync(join(tmpdir(), 'atomizer-bounded-log-'));
  roots.push(root);
  return join(root, 'launcher.log');
}
