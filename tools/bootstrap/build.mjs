import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { optionsFor, rustupTarget } from './plan.mjs';
import { verifiedDownload } from './download.mjs';
import { prepareNativeRust } from './rust.mjs';
import { report, runStep } from './failures.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
process.chdir(root);
const options = optionsFor(process.argv.slice(2), process.platform);
const nodeVersion = (await readFile('.node-version', 'utf8')).trim();
if (process.version !== `v${nodeVersion}`) {
  console.error(`Use build.ps1 or build.sh to prepare Node ${nodeVersion}.`);
  process.exit(1);
}
/** Where the output of a failed npm or Cargo step is kept, to share with IT. */
const failureLog = resolve('.build-tools/last-error.log');
const cargoBin = join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'bin');
process.env.PATH = `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${cargoBin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`;

function probe(command, args = []) {
  return spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
}
function has(command, args = ['--version']) {
  return probe(command, args).status === 0;
}
function run(command, args) {
  console.log(`> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `Command failed (${result.status}): ${command}. Resolve the error above and rerun the build.`,
    );
}
function privileged(command, args) {
  if (process.getuid?.() === 0) run(command, args);
  else run('sudo', [command, ...args]);
}
function requireSystemInstall(message) {
  if (options.check || options.skipSystemInstall)
    throw new Error(`${message}. See https://v2.tauri.app/start/prerequisites/`);
  console.log(message);
}
function visualStudio() {
  const vswhere = join(
    process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)',
    'Microsoft Visual Studio/Installer/vswhere.exe',
  );
  return (
    existsSync(vswhere) &&
    Boolean(
      probe(vswhere, [
        '-latest',
        '-products',
        '*',
        '-requires',
        'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '-property',
        'installationPath',
      ]).stdout?.trim(),
    )
  );
}
function webview() {
  return [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]
    .filter(Boolean)
    .some((base) => existsSync(join(base, 'Microsoft/EdgeWebView/Application')));
}
async function systemDependencies() {
  if (process.platform === 'win32') {
    for (const [ready, id, extra] of [
      [
        visualStudio(),
        'Microsoft.VisualStudio.2022.BuildTools',
        ['--override', '--wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'],
      ],
      [webview(), 'Microsoft.EdgeWebView2Runtime', []],
      [has('git'), 'Git.Git', []],
    ]) {
      if (ready) continue;
      requireSystemInstall(
        `Missing ${id}; preparing it through WinGet (installer/UAC prompts may appear)`,
      );
      if (!has('winget'))
        throw new Error(
          'WinGet is unavailable. Install Windows App Installer or install the missing prerequisite manually, then rerun.',
        );
      run('winget', ['install', '--id', id, '--exact', '--source', 'winget', ...extra]);
    }
    if (!visualStudio() || !webview() || !has('git'))
      throw new Error(
        'Complete the Windows installers, restart the terminal (or Windows if requested), then rerun build.ps1.',
      );
  } else if (process.platform === 'darwin') {
    if (!has('xcrun', ['--find', 'clang'])) {
      requireSystemInstall('Xcode Command Line Tools are missing');
      run('xcode-select', ['--install']);
      throw new Error('Complete the Apple installer, then rerun bash build.sh.');
    }
  } else {
    const modules = ['webkit2gtk-4.1', 'openssl', 'dbus-1'];
    const binaries = [
      'cc',
      'pkg-config',
      'git',
      'curl',
      'wget',
      'file',
      'patchelf',
      ...(options.bundles.includes('rpm') ? ['rpm'] : []),
    ];
    const missing = binaries.filter((command) => !has(command));
    if (!missing.length && has('pkg-config', ['--exists', ...modules])) return;
    requireSystemInstall(
      `Linux build libraries are missing (${missing.join(', ') || modules.join(', ')}); administrator access may be requested`,
    );
    if (has('apt-get')) {
      privileged('apt-get', ['update']);
      privileged('apt-get', [
        'install',
        '-y',
        'build-essential',
        'git',
        'curl',
        'wget',
        'file',
        'pkg-config',
        'libwebkit2gtk-4.1-dev',
        'libayatana-appindicator3-dev',
        'librsvg2-dev',
        'libdbus-1-dev',
        'libssl-dev',
        'libxdo-dev',
        'patchelf',
        'rpm',
      ]);
    } else if (has('dnf')) {
      privileged('dnf', [
        'install',
        '-y',
        'gcc',
        'gcc-c++',
        'make',
        'git',
        'curl',
        'wget',
        'file',
        'pkgconf-pkg-config',
        'webkit2gtk4.1-devel',
        'openssl-devel',
        'dbus-devel',
        'libappindicator-gtk3-devel',
        'librsvg2-devel',
        'libxdo-devel',
        'patchelf',
        'rpm-build',
      ]);
    } else
      throw new Error(
        'Automatic Linux setup supports APT and DNF. Install Tauri prerequisites with your distribution package manager, then rerun.',
      );
  }
}
async function rustDependencies() {
  if (!has('rustup')) {
    if (options.check)
      throw new Error('Rustup is missing. Run the build without --check to prepare it.');
    const target = rustupTarget(process.platform, process.arch);
    const name = process.platform === 'win32' ? 'rustup-init.exe' : 'rustup-init';
    const installer = await verifiedDownload(
      `https://static.rust-lang.org/rustup/dist/${target}/${name}`,
      resolve('.build-tools/downloads', `${target}-${name}`),
    );
    if (process.platform !== 'win32') await chmod(installer, 0o755);
    run(installer, [
      '-y',
      '--no-modify-path',
      '--profile',
      'minimal',
      '--default-toolchain',
      'none',
    ]);
  }
  const toolchain = (await readFile('rust-toolchain.toml', 'utf8')).match(
    /^channel\s*=\s*"([^"]+)"/m,
  )?.[1];
  if (!toolchain) throw new Error('Pinned Rust toolchain not found');
  prepareNativeRust({
    version: toolchain,
    platform: process.platform,
    arch: process.arch,
    check: options.check,
    env: process.env,
    probe,
    run,
    log: console.log,
  });
}
async function npmCli() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ].filter(Boolean);
  for (const path of candidates) if (existsSync(path)) return resolve(path);
  // Version managers may expose node through a symlink; find npm's installed module.
  const root = probe(process.platform === 'win32' ? 'where.exe' : 'which', ['npm'])
    .stdout?.trim()
    .split(/\r?\n/)[0];
  if (root) {
    const { realpath } = await import('node:fs/promises');
    const path = await realpath(root);
    if (path.endsWith('npm-cli.js')) return path;
  }
  throw new Error(
    'npm CLI not found beside Node. Use the official Node distribution or the bootstrap download.',
  );
}

try {
  console.log(
    `Nexo source build: ${process.platform}/${process.arch}, Node ${nodeVersion}, bundles ${options.bundles.join(',')}`,
  );
  await systemDependencies();
  await rustDependencies();
  const npm = await npmCli();
  if (options.check) {
    console.log(
      'Build prerequisites are available. Check mode did not install tools or dependencies.',
    );
  } else if (options.toolsOnly) {
    console.log('Build tools are ready. npm dependencies and installers were not built.');
  } else {
    // Only the build tools: lint, tests and their servers are for development (package.json).
    await runStep(
      'Installing npm dependencies',
      process.execPath,
      [npm, 'ci', '--omit=dev', '--no-audit', '--no-fund'],
      { log: failureLog },
    );
    if (options.prepareOnly)
      console.log(
        'Tools and npm dependencies are ready. Rerun without --prepare-only to build installers.',
      );
    else {
      if (process.platform === 'darwin') process.env.APPLE_SIGNING_IDENTITY ??= '-';
      if (process.platform === 'linux') process.env.NO_STRIP ??= 'true';
      await runStep(
        'Building the desktop installers',
        process.execPath,
        [npm, 'run', 'desktop:build', '--', '--bundles', options.bundles.join(',')],
        { log: failureLog },
      );
      console.log(`Native packages are in ${resolve('target/release/bundle')}`);
    }
  }
} catch (error) {
  report('Build stopped', error);
  process.exitCode = 1;
}
