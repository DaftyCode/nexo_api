// Copies the native installers and the database modules of every platform to one folder,
// with stable names, and checks that each manifest the apps embed names a staged module.
import { copyFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

const source = resolve(process.argv[2] ?? '.verification/native');
const destination = resolve(process.argv[3] ?? '.verification/upload');
if (source === destination || destination.startsWith(source + sep))
  throw new Error('Use separate input and staging directories');
await mkdir(destination, { recursive: true });
const names = new Set();
const manifests = [];
async function stage(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await stage(path);
    else if (entry.isFile() && /^modules-[\w.-]+\.json$/.test(entry.name)) manifests.push(path);
    else if (
      entry.isFile() &&
      (/\.(msi|msix|exe|dmg|deb|rpm|AppImage)$/.test(entry.name) ||
        /^nexo-driver-[\w.-]+\.gz$/.test(entry.name))
    ) {
      const name = basename(path).replace(/\s+/g, '.');
      if (names.has(name)) throw new Error(`Duplicate release asset: ${name}`);
      names.add(name);
      const output = resolve(destination, name);
      if (dirname(output) !== destination) throw new Error('Unexpected release asset path');
      await copyFile(path, output);
    }
  }
}
await stage(source);
if (!names.size) throw new Error('No native installers found');
// An app downloads its modules from the release of its version: every file its manifest
// names must be there, with the size the manifest says.
for (const path of manifests) {
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  for (const module of manifest.modules) {
    if (!names.has(module.file)) throw new Error(`${path} names ${module.file}, not staged`);
    const { size } = await stat(resolve(destination, module.file));
    if (size !== module.compressedSize)
      throw new Error(`${module.file} is not the manifest's file`);
  }
}
console.log(`Staged ${names.size} release assets with stable filenames.`);
