// Installs and starts the local web version of Nexo API on this computer.
//
// - Builds the web interface and the Rust launcher when they are not installed yet, or
//   with --rebuild. An existing installation is started as is; newer sources are reported.
// - Starts the launcher in the background. It opens the browser with a one-time sign-in
//   link; when Nexo is already running it only opens a new browser session.
//
//   node tools/install/web.mjs [--rebuild] [--stop] [--status] [--no-open]
//   NEXO_WEB_PORT changes the port (default 4000).
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
process.chdir(root);
const windows = process.platform === 'win32';
const args = new Set(process.argv.slice(2));
const port = process.env.NEXO_WEB_PORT ?? '4000';
const home = join(root, '.nexo-web');
const logs = join(home, 'logs');
const stampPath = join(home, 'install.json');
/** The desktop app's data directory, shared with the web version. */
function dataDirectory() {
  if (process.env.NEXO_DATA_DIR) return process.env.NEXO_DATA_DIR;
  if (windows)
    return join(process.env.APPDATA ?? join(homedir(), 'AppData/Roaming'), 'dev.nexo.api');
  if (process.platform === 'darwin')
    return join(homedir(), 'Library/Application Support/dev.nexo.api');
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'dev.nexo.api');
}
const instancePath = join(dataDirectory(), 'web-instance.json');
const launcher = join(
  resolve(root, process.env.CARGO_TARGET_DIR ?? 'target'),
  'release',
  windows ? 'nexo-server.exe' : 'nexo-server',
);
const webRoot = join(root, 'dist', 'nexo', 'browser');

function run(command, commandArgs) {
  console.log(`> ${[command, ...commandArgs].join(' ')}`);
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status) throw new Error(`${command} failed with exit code ${result.status}`);
}
const npm = () => {
  const cli =
    process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  if (!existsSync(cli))
    throw new Error('npm was not found next to Node; run the install-web script');
  return cli;
};
const cargo = () => {
  const local = join(homedir(), '.cargo', 'bin', windows ? 'cargo.exe' : 'cargo');
  return existsSync(local) ? local : 'cargo';
};

/** Fingerprint of everything the installation is built from. */
function fingerprint() {
  const hash = createHash('sha256');
  const walk = (path) => {
    if (!existsSync(path)) return;
    const info = statSync(path);
    if (info.isDirectory()) {
      for (const entry of readdirSync(path).sort())
        if (!['node_modules', 'dist', 'target'].includes(entry)) walk(join(path, entry));
    } else hash.update(`${path}:${info.size}:${info.mtimeMs}\n`);
  };
  for (const path of [
    'package-lock.json',
    'Cargo.lock',
    'angular.json',
    'src',
    'public',
    'backend',
  ])
    walk(path);
  return hash.digest('hex');
}
/**
 * Whether this script built the launcher and the interface that exist now. Installations
 * from earlier versions record no launcher and are built again once.
 */
function installed() {
  if (![launcher, join(webRoot, 'index.html')].every(existsSync)) return false;
  try {
    return JSON.parse(readFileSync(stampPath, 'utf8')).launcher === launcher;
  } catch {
    return false;
  }
}
/** Whether the sources changed since the installation was built. */
function outdated() {
  try {
    return JSON.parse(readFileSync(stampPath, 'utf8')).fingerprint !== fingerprint();
  } catch {
    return true;
  }
}
function build() {
  console.log('Building Nexo API web (this takes a few minutes the first time)...');
  if (!existsSync('node_modules/.package-lock.json'))
    run(process.execPath, [npm(), 'ci', '--no-audit', '--no-fund']);
  run(process.execPath, ['node_modules/@angular/cli/bin/ng.js', 'build']);
  run(cargo(), ['build', '--locked', '--release', '-p', 'nexo-server']);
  mkdirSync(home, { recursive: true });
  writeFileSync(
    stampPath,
    JSON.stringify(
      { fingerprint: fingerprint(), launcher, installedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
}
function instance() {
  try {
    return JSON.parse(readFileSync(instancePath, 'utf8'));
  } catch {
    return undefined;
  }
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Whether the instance recorded in the data directory answers. */
async function running() {
  const current = instance();
  if (!current?.port) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${current.port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function stop() {
  const current = instance();
  if (!current?.pid || !alive(current.pid)) return console.log('Nexo API web is not running.');
  if (windows)
    spawnSync('taskkill', ['/PID', String(current.pid), '/T', '/F'], { stdio: 'ignore' });
  else process.kill(current.pid, 'SIGTERM');
  console.log('Nexo API web stopped.');
}

/** Runs the launcher in the background; it opens the browser itself. */
async function launch() {
  mkdirSync(logs, { recursive: true });
  const launcherArgs = [
    '--port',
    port,
    '--web',
    webRoot,
    ...(args.has('--no-open') ? ['--no-open'] : []),
  ];
  if (await running()) {
    // A second launcher run only asks the running instance for a new sign-in link.
    run(launcher, launcherArgs);
    return;
  }
  const log = openSync(join(logs, 'nexo.log'), 'a');
  const child = spawn(launcher, launcherArgs, {
    cwd: root,
    env: process.env,
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  child.unref();
  for (let attempt = 0; attempt < 120; attempt++) {
    if (instance()?.pid === child.pid) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (instance()?.pid !== child.pid) throw new Error(`Nexo API did not start. Logs: ${logs}`);
  const text = readFileSync(join(logs, 'nexo.log'), 'utf8');
  const link = [...text.matchAll(/Sign-in link[^:]*: (\S+)/g)].at(-1)?.[1];
  console.log(`\nNexo API web is running at http://127.0.0.1:${instance().port}`);
  if (args.has('--no-open') && link) console.log(`Open this link once: ${link}`);
  console.log(`Logs: ${logs}`);
  console.log(
    `Stop it with: ${windows ? '.\\install-web.ps1 -Stop' : 'bash install-web.sh --stop'}`,
  );
}

if (args.has('--stop')) stop();
else if (args.has('--status')) {
  console.log((await running()) ? `Running at http://127.0.0.1:${instance().port}` : 'Not running');
} else {
  if (args.has('--rebuild') && (await running())) stop();
  if (args.has('--rebuild') || !installed()) build();
  else if (outdated())
    console.log(
      `Nexo API web is installed. The sources changed since it was built; update it with ${
        windows ? '.\\install-web.ps1 -Rebuild' : 'bash install-web.sh --rebuild'
      }.`,
    );
  else console.log('Nexo API web is installed and up to date.');
  await launch();
}
