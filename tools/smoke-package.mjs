// Installs the native package built on this runner and checks what it contains:
// the application binary is installed and no Node runtime or JavaScript engine ships with it.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const bundle = 'target/release/bundle';
const find = (directory, extension) =>
  existsSync(join(bundle, directory))
    ? readdirSync(join(bundle, directory))
        .filter((name) => name.endsWith(extension))
        .map((name) => join(bundle, directory, name))
    : [];
const forbidden = /nexo-node|engine\.mjs|runtime-worker\.mjs|node_modules/;
function check(files) {
  const leftovers = files.filter((file) => forbidden.test(file));
  if (leftovers.length) throw new Error(`The package still contains:\n${leftovers.join('\n')}`);
}
function walk(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

if (process.platform === 'linux') {
  const [deb] = find('deb', '.deb');
  if (!deb) throw new Error('No .deb package was built');
  execFileSync('sudo', ['apt-get', 'install', '-y', `./${deb}`], { stdio: 'inherit' });
  const name = execFileSync('dpkg-deb', ['-f', deb, 'Package'], { encoding: 'utf8' }).trim();
  const files = execFileSync('dpkg', ['-L', name], { encoding: 'utf8' }).split('\n');
  check(files);
  const binaries = files.filter((file) => file.startsWith('/usr/bin/'));
  if (!binaries.length) throw new Error('The package installs no executable');
  console.log(`Installed ${name}: ${binaries.join(', ')}`);
  execFileSync('sudo', ['apt-get', 'remove', '-y', name], { stdio: 'inherit' });
} else if (process.platform === 'win32') {
  const [msi] = find('msi', '.msi');
  if (!msi) throw new Error('No .msi package was built');
  execFileSync('msiexec', ['/i', msi, '/qn', '/norestart'], { stdio: 'inherit' });
  const directory = join(process.env.ProgramFiles ?? 'C:\Program Files', 'Nexo API');
  if (!existsSync(directory)) throw new Error(`Nothing was installed in ${directory}`);
  const files = walk(directory);
  check(files);
  if (!files.some((file) => file.endsWith('.exe'))) throw new Error('No executable installed');
  console.log(`Installed in ${directory}: ${files.length} files`);
  execFileSync('msiexec', ['/x', msi, '/qn', '/norestart'], { stdio: 'inherit' });
} else if (process.platform === 'darwin') {
  const apps = existsSync(join(bundle, 'macos')) ? readdirSync(join(bundle, 'macos')) : [];
  const app = apps.find((name) => name.endsWith('.app'));
  if (!app) throw new Error('No .app bundle was built');
  const files = walk(join(bundle, 'macos', app));
  check(files);
  if (!files.some((file) => file.includes('/Contents/MacOS/'))) throw new Error('No executable');
  console.log(`${app}: ${files.length} files`);
}
