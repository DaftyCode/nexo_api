import assert from 'node:assert/strict';
import test from 'node:test';
import { hintFor, runStep, StepError } from './failures.mjs';

test('explains a registry mirror that cuts the npm download', () => {
  const output = [
    'npm error code ECONNRESET',
    'npm error network aborted',
    'npm error network request to https://nexus.example.com/repository/npm/@angular/core/-/core-22.0.0.tgz failed, reason: socket hang up',
    'npm warn cleanup Failed to remove some directories [',
    "npm warn cleanup   [Error: EPERM: operation not permitted, rmdir 'D:\\nexo\\node_modules\\@esbuild']",
  ].join('\n');
  const hint = hintFor(output, 'win32');
  assert.match(hint, /download failed \(ECONNRESET\)/);
  assert.match(hint, /npm_config_fetch_retries=5/);
  assert.match(
    hint,
    /Invoke-WebRequest -Method Head https:\/\/nexus\.example\.com\/repository\/npm\/@angular\/core\/-\/core-22\.0\.0\.tgz/,
  );
  assert.match(hint, /give IT that exact URL/);
  assert.match(hintFor(output, 'linux'), /curl -I https:\/\/nexus/);
});

test('explains Cargo download failures with Cargo settings', () => {
  const hint = hintFor(
    'warning: spurious network error (3 tries remaining): [28] Timeout was reached (Operation timed out after 30000 milliseconds)\nerror: failed to download from `https://static.crates.io/crates/aws-lc-sys/0.47.0/download`',
    'win32',
  );
  assert.match(hint, /CARGO_NET_RETRY=10/);
  assert.doesNotMatch(hint, /npm_config/);
});

test('explains node_modules files held by an editor or a dev server', () => {
  const hint = hintFor(
    "npm warn cleanup Failed to remove some directories\nnpm warn cleanup [Error: EPERM: operation not permitted, rmdir 'C:\\nexo\\node_modules\\sass']\nnpm error code EBUSY",
  );
  assert.match(hint, /node_modules are in use/);
  assert.match(hint, /delete node_modules/);
});

test('explains an antivirus that blocks a Rust build script', () => {
  const output = [
    'error: failed to run custom build command for `aws-lc-sys v0.47.0`',
    '',
    'Caused by:',
    '  could not execute process `D:\\PROYECTOS\\nexo\\target\\release\\build\\aws-lc-sys-1a2b\\build-script-main` (never executed)',
    '',
    'Caused by:',
    '  Acceso denegado. (os error 5)',
  ].join('\n');
  const hint = hintFor(output, 'win32');
  assert.match(hint, /antivirus/);
  assert.match(hint, /exclude the build folder D:\\PROYECTOS\\nexo\\target,/);
});

test('explains a build output locked by a running program', () => {
  assert.match(
    hintFor(
      'error: failed to remove file `D:\\nexo\\target\\release\\nexo-server.exe`\n\nCaused by:\n  Access is denied. (os error 5)',
    ),
    /running Nexo API/,
  );
});

test('ignores colour codes and gives no hint for unknown failures', () => {
  assert.match(
    hintFor('\u001b[31mnpm error\u001b[0m code \u001b[1mETIMEDOUT\u001b[0m'),
    /ETIMEDOUT/,
  );
  assert.equal(hintFor('error[E0308]: mismatched types'), undefined);
  assert.equal(hintFor(undefined), undefined);
});

test('runs a step, keeps its output and rejects with the hint and exit code', async () => {
  await runStep('Printing', process.execPath, ['-e', 'console.log("ok")']);
  const failing = runStep('Installing npm dependencies', process.execPath, [
    '-e',
    'console.error("npm error code ECONNRESET"); process.exit(3)',
  ]);
  await assert.rejects(failing, (error) => {
    assert.ok(error instanceof StepError);
    assert.equal(error.message, 'Installing npm dependencies failed (exit code 3).');
    assert.match(error.hint, /ECONNRESET/);
    return true;
  });
});
