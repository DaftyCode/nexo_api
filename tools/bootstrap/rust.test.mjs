import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareNativeRust } from './rust.mjs';

const native = '1.99.1-x86_64-pc-windows-msvc';
const ready = { status: 0, stdout: 'rustc 1.99.1\r\nhost: x86_64-pc-windows-msvc\r\n', stderr: '' };
const missing = { status: 1, stdout: '', stderr: 'error: toolchain is not installed' };

function fixture(overrides = {}) {
  const calls = [];
  const messages = [];
  const options = {
    version: '1.99.1',
    platform: 'win32',
    arch: 'x64',
    check: false,
    env: {},
    probe(command, args) {
      calls.push([command, ...args]);
      return ready;
    },
    run(command, args) {
      calls.push([command, ...args]);
    },
    log(message) {
      messages.push(message);
    },
    ...overrides,
  };
  return { options, calls, messages };
}

test('uses MSVC for the build even when a Windows GNU toolchain was selected', () => {
  const { options, calls, messages } = fixture({
    env: { RUSTUP_TOOLCHAIN: 'stable-x86_64-pc-windows-gnu' },
  });
  prepareNativeRust(options);
  assert.equal(options.env.RUSTUP_TOOLCHAIN, native);
  assert.deepEqual(calls, [['rustup', 'run', native, 'rustc', '-vV']]);
  assert.match(messages[0], /instead of RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu/);
});

test('installs the fully qualified native toolchain without self-updating rustup or changing global Rust defaults', () => {
  let installed = false;
  const { options, calls } = fixture();
  options.probe = (command, args) => {
    calls.push([command, ...args]);
    return installed ? ready : missing;
  };
  options.run = (command, args) => {
    calls.push([command, ...args]);
    installed = true;
  };
  prepareNativeRust(options);
  assert.deepEqual(calls, [
    ['rustup', 'run', native, 'rustc', '-vV'],
    [
      'rustup',
      'toolchain',
      'install',
      native,
      '--no-self-update',
      '--profile',
      'minimal',
      '--component',
      'clippy',
      '--component',
      'rustfmt',
    ],
    ['rustup', 'run', native, 'rustc', '-vV'],
  ]);
  assert.equal(options.env.RUSTUP_TOOLCHAIN, native);
});

test('check mode reports the Rustup diagnostic without installing or changing the environment', () => {
  const { options, calls } = fixture({ check: true, probe: () => missing });
  assert.throws(
    () => prepareNativeRust(options),
    /unavailable.*Rustup reported: error: toolchain is not installed/,
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(options.env, {});
});

test('failed compiler probes preserve the actual error instead of reporting architecture mismatch', () => {
  for (const failed of [
    { status: 1, stderr: 'corporate proxy: download failed' },
    { status: null, error: new Error('spawn rustup ENOENT') },
  ]) {
    const { options } = fixture({ probe: () => failed });
    assert.throws(
      () => prepareNativeRust(options),
      /Cannot run Rust.*(corporate proxy: download failed|spawn rustup ENOENT)/,
    );
    assert.deepEqual(options.env, {});
  }
});

test('checks the compiler host exactly, rejecting absent hosts and incompatible ABIs or CPUs', () => {
  for (const stdout of ['', 'host: x86_64-pc-windows-gnu\n', 'host: aarch64-pc-windows-msvc\n']) {
    const { options } = fixture({ probe: () => ({ status: 0, stdout }) });
    assert.throws(() => prepareNativeRust(options), /no compiler host|native build requires/);
    assert.deepEqual(options.env, {});
  }
});

test('rejects explicit cross-compilation before installing tools', () => {
  const { options, calls } = fixture({ env: { CARGO_BUILD_TARGET: 'aarch64-pc-windows-msvc' } });
  assert.throws(() => prepareNativeRust(options), /CARGO_BUILD_TARGET=.*cross-compilation/);
  assert.deepEqual(calls, []);
});

test('selects the native toolchain on both macOS architectures and Linux', () => {
  for (const [platform, arch, host] of [
    ['darwin', 'arm64', 'aarch64-apple-darwin'],
    ['darwin', 'x64', 'x86_64-apple-darwin'],
    ['linux', 'x64', 'x86_64-unknown-linux-gnu'],
  ]) {
    const { options, calls } = fixture({
      platform,
      arch,
      probe: () => ({ status: 0, stdout: `host: ${host}\n` }),
    });
    prepareNativeRust(options);
    assert.equal(options.env.RUSTUP_TOOLCHAIN, `1.99.1-${host}`);
    assert.deepEqual(calls, []);
  }
});
