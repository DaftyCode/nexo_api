import assert from 'node:assert/strict';
import test from 'node:test';
import { checksumFrom, optionsFor, rustupTarget, validateNativeToolchain } from './plan.mjs';

test('selects native packages and rejects invalid arguments before installing anything', () => {
  assert.deepEqual(optionsFor([], 'win32').bundles, ['nsis', 'msi']);
  assert.deepEqual(optionsFor([], 'darwin').bundles, ['app', 'dmg']);
  assert.deepEqual(optionsFor(['--bundles', 'deb'], 'linux').bundles, ['deb']);
  assert.throws(() => optionsFor(['--bundles', 'msi'], 'linux'));
  assert.throws(() => optionsFor(['--bundles'], 'win32'));
  assert.throws(() => optionsFor(['--unrecognized'], 'darwin'));
  assert.equal(optionsFor(['--check', '--skip-system-install'], 'linux').check, true);
});
test('keeps the Node sidecar and Rust installer on the same native architecture', () => {
  assert.equal(rustupTarget('darwin', 'arm64'), 'aarch64-apple-darwin');
  assert.equal(rustupTarget('win32', 'x64'), 'x86_64-pc-windows-msvc');
  assert.equal(rustupTarget('linux', 'x64'), 'x86_64-unknown-linux-gnu');
  assert.throws(() => rustupTarget('linux', 'ia32'));
  assert.doesNotThrow(() =>
    validateNativeToolchain('1.99.1-aarch64-apple-darwin', 'darwin', 'arm64'),
  );
  assert.throws(
    () => validateNativeToolchain('1.99.1-aarch64-apple-darwin', 'darwin', 'x64'),
    /same native architecture/,
  );
});
test('refuses malformed download checksums', () => {
  assert.equal(checksumFrom(`${'A'.repeat(64)}  rustup-init.exe\n`), 'a'.repeat(64));
  for (const value of ['', '404 not found', 'a'.repeat(63), '<html>error</html>'])
    assert.throws(() => checksumFrom(value));
});
