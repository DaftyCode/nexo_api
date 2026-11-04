import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

const source = resolve(process.argv[2] ?? '.verification/native');
const destination = resolve(process.argv[3] ?? '.verification/upload');
if (source === destination || destination.startsWith(source + sep))
  throw new Error('Use separate input and staging directories');
await mkdir(destination, { recursive: true });
const names = new Set();
async function stage(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await stage(path);
    else if (entry.isFile() && /\.(msi|msix|exe|dmg|deb|rpm|AppImage)$/.test(entry.name)) {
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
console.log(`Staged ${names.size} release assets with stable filenames.`);
