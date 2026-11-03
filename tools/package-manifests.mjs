import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stringify } from 'yaml';

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (entry.isFile() && /\.(msi|exe|dmg|deb|rpm|AppImage)$/.test(entry.name))
      result.push(path);
  }
  return result;
}

export async function generatePackageManifests({
  artifacts,
  version,
  repository,
  output = '.verification/packages',
}) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? ''))
    throw new Error('A stable semantic version is required');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? ''))
    throw new Error('A GitHub owner/repository is required');
  const inputs = await files(resolve(artifacts));
  const names = new Set();
  const assets = [];
  for (const path of inputs) {
    const name = basename(path);
    if (names.has(name)) throw new Error(`Duplicate release asset: ${name}`);
    if (/[\r\n\\]/.test(name)) throw new Error('Invalid release asset filename');
    names.add(name);
    const data = await readFile(path);
    assets.push({
      name,
      sha256: createHash('sha256').update(data).digest('hex'),
      url: `https://github.com/${repository}/releases/download/v${version}/${encodeURIComponent(name)}`,
    });
  }
  const msi = assets.filter((asset) => asset.name.endsWith('.msi'));
  const arm = assets.find((asset) => /(?:aarch64|arm64).*\.dmg$/.test(asset.name));
  const intel = assets.find((asset) => /(?:x64|x86_64).*\.dmg$/.test(asset.name));
  if (
    !msi.length ||
    !arm ||
    !intel ||
    !assets.some((asset) => asset.name.endsWith('.deb')) ||
    !assets.some((asset) => asset.name.endsWith('.rpm'))
  )
    throw new Error('Windows MSI, both macOS architectures, DEB and RPM packages are required');
  const identity = { PackageIdentifier: 'DaftyCode.NexoAPI', PackageVersion: version };
  const manifestVersion = '1.12.0';
  const installer = {
    ...identity,
    InstallerType: 'wix',
    InstallModes: ['interactive', 'silent', 'silentWithProgress'],
    UpgradeBehavior: 'install',
    Installers: msi.map((asset) => ({
      Architecture: /arm64|aarch64/.test(asset.name) ? 'arm64' : 'x64',
      InstallerUrl: asset.url,
      InstallerSha256: asset.sha256.toUpperCase(),
    })),
    ManifestType: 'installer',
    ManifestVersion: manifestVersion,
  };
  const locale = {
    ...identity,
    PackageLocale: 'en-US',
    Publisher: 'DaftyCode',
    PublisherUrl: `https://github.com/${repository.split('/')[0]}`,
    PackageName: 'Nexo API',
    PackageUrl: `https://github.com/${repository}`,
    License: 'MIT',
    LicenseUrl: `https://github.com/${repository}/blob/master/LICENSE`,
    ShortDescription: 'Open source API workspace for desktop and self-hosted servers.',
    Tags: ['api', 'developer-tools', 'http', 'tauri', 'rust'],
    ManifestType: 'defaultLocale',
    ManifestVersion: manifestVersion,
  };
  const manifest = {
    ...identity,
    DefaultLocale: 'en-US',
    ManifestType: 'version',
    ManifestVersion: manifestVersion,
  };
  const destination = resolve(output);
  const winget = join(destination, 'winget', 'manifests', 'd', 'DaftyCode', 'NexoAPI', version);
  await mkdir(winget, { recursive: true });
  await mkdir(join(destination, 'Casks'), { recursive: true });
  for (const [suffix, value] of [
    ['installer', installer],
    ['locale.en-US', locale],
    ['', manifest],
  ]) {
    const schema = `https://aka.ms/winget-manifest.${value.ManifestType}.${manifestVersion}.schema.json`;
    await writeFile(
      join(winget, `DaftyCode.NexoAPI${suffix ? `.${suffix}` : ''}.yaml`),
      `# yaml-language-server: $schema=${schema}\n\n${stringify(value)}`,
    );
  }
  const cask = `cask "nexo-api" do\n  version "${version}"\n\n  on_arm do\n    sha256 "${arm.sha256}"\n    url "${arm.url}"\n  end\n\n  on_intel do\n    sha256 "${intel.sha256}"\n    url "${intel.url}"\n  end\n\n  name "Nexo API"\n  desc "Open source API workspace for desktop and self-hosted servers"\n  homepage "https://github.com/${repository}"\n\n  depends_on :macos\n  app "Nexo API.app"\nend\n`;
  await writeFile(join(destination, 'Casks', 'nexo-api.rb'), cask);
  await writeFile(
    join(destination, 'SHA256SUMS'),
    assets
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((asset) => `${asset.sha256}  ${asset.name}`)
      .join('\n') + '\n',
  );
  await writeFile(
    join(destination, 'assets.json'),
    JSON.stringify({ version, repository, assets }, null, 2) + '\n',
  );
  return { version, assets: assets.length, output: destination };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2),
    options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index].replace(/^--/, '');
    if (!['artifacts', 'version', 'repository', 'output'].includes(key) || !args[index + 1])
      throw new Error('Expected --artifacts, --version, --repository and optional --output');
    options[key] = args[index + 1];
  }
  console.log(JSON.stringify(await generatePackageManifests(options), null, 2));
}
