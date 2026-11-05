import { rustupTarget } from './plan.mjs';

function commandFailure(result) {
  return (
    result.error?.message ||
    result.stderr?.trim() ||
    result.stdout?.trim() ||
    `exit status ${result.status}`
  );
}

// Select the host explicitly: a bare version inherits rustup's default host,
// which may be GNU or a different CPU even on a native Windows terminal.
export function prepareNativeRust({ version, platform, arch, check, env, probe, run, log }) {
  const host = rustupTarget(platform, arch);
  const toolchain = `${version}-${host}`;
  if (env.CARGO_BUILD_TARGET && env.CARGO_BUILD_TARGET !== host)
    throw new Error(
      `CARGO_BUILD_TARGET=${env.CARGO_BUILD_TARGET} requests cross-compilation; this build needs ${host}. Use a terminal without that override.`,
    );

  const args = ['run', toolchain, 'rustc', '-vV'];
  let compiler = probe('rustup', args);
  if (compiler.error || compiler.status !== 0) {
    if (check)
      throw new Error(
        `Rust ${toolchain} is unavailable. Run without --check to prepare it. Rustup reported: ${commandFailure(compiler)}`,
      );
    // Updating rustup itself is not part of this build: a failed self-update
    // (locked or missing rustup-init, proxy) would fail an install that worked.
    run('rustup', [
      'toolchain',
      'install',
      toolchain,
      '--no-self-update',
      '--profile',
      'minimal',
      '--component',
      'clippy',
      '--component',
      'rustfmt',
    ]);
    compiler = probe('rustup', args);
  }
  if (compiler.error || compiler.status !== 0)
    throw new Error(`Cannot run Rust ${toolchain}. Rustup reported: ${commandFailure(compiler)}`);

  const actualHost = compiler.stdout?.match(/^host:\s*(\S+)\s*$/m)?.[1];
  if (!actualHost)
    throw new Error(`Rust ${toolchain} returned no compiler host in rustc -vV output.`);
  if (actualHost !== host)
    throw new Error(`Rust compiler host is ${actualHost}; this native build requires ${host}.`);

  if (env.RUSTUP_TOOLCHAIN && env.RUSTUP_TOOLCHAIN !== toolchain)
    log(`Using ${toolchain} for this build instead of RUSTUP_TOOLCHAIN=${env.RUSTUP_TOOLCHAIN}.`);
  // Only the bootstrap and its child processes inherit this selection. Do not
  // change rustup's default host, default toolchain or directory overrides.
  env.RUSTUP_TOOLCHAIN = toolchain;
  log(`Rust ${toolchain} (compiler host verified)`);
}
