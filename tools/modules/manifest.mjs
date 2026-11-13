// The manifest of the database modules, as `nexo-modules` reads it: one entry per driver
// with the sizes and SHA-256 of the driver and of its release asset (the driver compressed
// with gzip). Used to publish the modules and by the tests that serve them.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

/** The version of the driver protocol of `nexo-driver-sdk`. */
export const PROTOCOL_VERSION = 1;

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The executable of a module's driver on this platform. */
export const executableName = (id) =>
  `nexo-driver-${id}${process.platform === 'win32' ? '.exe' : ''}`;

/** The release asset of a driver and its entry in the manifest. */
export function moduleEntry({
  id,
  name,
  description = '',
  version,
  driver,
  file,
  licenses = [],
  protocol = PROTOCOL_VERSION,
}) {
  const asset = gzipSync(driver, { level: 9 });
  return {
    asset,
    entry: {
      id,
      name,
      description,
      version,
      protocol,
      file,
      size: driver.length,
      sha256: sha256(driver),
      compressedSize: asset.length,
      compressedSha256: sha256(asset),
      licenses,
    },
  };
}

/** The Rust target triple of this computer: what a build of Nexo without `--target` uses. */
export function hostTarget() {
  const rustc =
    process.platform === 'win32' ? join(homedir(), '.cargo', 'bin', 'rustc.exe') : 'rustc';
  const output = execFileSync(rustc, ['-vV'], { encoding: 'utf8' });
  const host = /^host: (.+)$/m.exec(output);
  if (!host) throw new Error('rustc did not say its host target');
  return host[1].trim();
}
