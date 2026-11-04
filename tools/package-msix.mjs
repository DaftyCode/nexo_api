// Packages the Windows desktop app as MSIX for the Microsoft Store.
//
//   node tools/package-msix.mjs [--skip-build]
//
// The Store signs the package and delivers updates, so the result is not signed here.
// Identity values come from Partner Center (Product identity page):
//   NEXO_MSIX_NAME            Package/Identity/Name, e.g. 12345DaftyCode.NexoAPI
//   NEXO_MSIX_PUBLISHER       Package/Identity/Publisher, e.g. CN=XXXXXXXX-XXXX-...
//   NEXO_MSIX_PUBLISHER_NAME  Package/Properties/PublisherDisplayName
// Without them a local test package with placeholder values is produced.
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

if (process.platform !== 'win32') throw new Error('MSIX packages are built on Windows.');
const root = resolve(import.meta.dirname, '..');
process.chdir(root);
const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const target = resolve(process.env.CARGO_TARGET_DIR ?? 'target');
const executable = join(target, 'release', 'nexo-desktop.exe');

const identity = {
  name: process.env.NEXO_MSIX_NAME ?? 'NexoAPI.LocalTest',
  publisher: process.env.NEXO_MSIX_PUBLISHER ?? 'CN=Nexo API Local Test',
  publisherName: process.env.NEXO_MSIX_PUBLISHER_NAME ?? config.bundle?.publisher ?? 'Nexo API',
};
const forStore = Boolean(process.env.NEXO_MSIX_NAME && process.env.NEXO_MSIX_PUBLISHER);

function run(command, args) {
  console.log(`> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status) throw new Error(`${command} failed with exit code ${result.status}`);
}
/** makeappx.exe from the newest installed Windows SDK. */
function makeappx() {
  const kits = join(
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    'Windows Kits/10/bin',
  );
  const versions = existsSync(kits)
    ? readdirSync(kits)
        .filter((v) => /^10\./.test(v))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    : [];
  for (const version of versions) {
    const tool = join(kits, version, 'x64', 'makeappx.exe');
    if (existsSync(tool)) return tool;
  }
  throw new Error(
    'makeappx.exe was not found. Install the Windows SDK: winget install --id Microsoft.WindowsSDK.10.0.26100 --exact',
  );
}
const escape = (text) =>
  String(text).replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c],
  );

if (!process.argv.includes('--skip-build') || !existsSync(executable)) {
  // The executable embeds the interface; installers are not needed for MSIX.
  run(process.execPath, ['tools/tauri.mjs', 'build', '--no-bundle']);
}
if (!existsSync(executable)) throw new Error(`The desktop executable was not built: ${executable}`);

const [major = 0, minor = 0, patch = 0] = String(config.version).split('.').map(Number);
const version = `${major}.${minor}.${patch}.0`;
const layout = join(target, 'msix', 'layout');
rmSync(layout, { recursive: true, force: true });
mkdirSync(join(layout, 'Assets'), { recursive: true });
copyFileSync(executable, join(layout, 'nexo-desktop.exe'));
for (const asset of ['StoreLogo.png', 'Square44x44Logo.png', 'Square150x150Logo.png'])
  copyFileSync(join('src-tauri/icons', asset), join(layout, 'Assets', asset));

writeFileSync(
  join(layout, 'AppxManifest.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap rescap">
  <Identity Name="${escape(identity.name)}" Publisher="${escape(identity.publisher)}" Version="${version}" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>${escape(config.productName)}</DisplayName>
    <PublisherDisplayName>${escape(identity.publisherName)}</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
    <Description>${escape(config.bundle?.shortDescription ?? config.productName)}</Description>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Resources>
    <Resource Language="en-us" />
    <Resource Language="es-es" />
  </Resources>
  <Applications>
    <Application Id="NexoAPI" Executable="nexo-desktop.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="${escape(config.productName)}" Description="${escape(config.bundle?.shortDescription ?? config.productName)}"
        BackgroundColor="transparent" Square150x150Logo="Assets\\Square150x150Logo.png" Square44x44Logo="Assets\\Square44x44Logo.png" />

    </Application>
  </Applications>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
`,
);

const output = join(target, 'msix', `Nexo.API_${version}_x64.msix`);
rmSync(output, { force: true });
run(makeappx(), ['pack', '/o', '/d', layout, '/p', output]);
console.log(`\nMSIX package: ${output}`);
console.log(
  forStore
    ? 'Upload it in Partner Center; the Store signs it.'
    : 'This is a local test package with placeholder identity. Set NEXO_MSIX_NAME, NEXO_MSIX_PUBLISHER and NEXO_MSIX_PUBLISHER_NAME from Partner Center for a Store submission.',
);
