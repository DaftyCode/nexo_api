export const bundlesByPlatform = {
  win32: ['nsis', 'msi'],
  darwin: ['app', 'dmg'],
  linux: ['appimage', 'deb', 'rpm'],
};

export function optionsFor(args, platform) {
  if (!bundlesByPlatform[platform]) throw new Error('Unsupported build operating system');
  const options = {
    check: false,
    prepareOnly: false,
    toolsOnly: false,
    skipSystemInstall: false,
    bundles: bundlesByPlatform[platform],
  };
  for (let index = 0; index < args.length; index++) {
    switch (args[index]) {
      case '--check':
        options.check = true;
        break;
      case '--prepare-only':
        options.prepareOnly = true;
        break;
      case '--tools-only':
        options.toolsOnly = true;
        break;
      case '--skip-system-install':
        options.skipSystemInstall = true;
        break;
      case '--bundles': {
        const bundles = args[++index]?.split(',');
        if (
          !bundles?.length ||
          bundles.some((bundle) => !bundlesByPlatform[platform].includes(bundle))
        ) {
          throw new Error(
            `Supported bundles on ${platform}: ${bundlesByPlatform[platform].join(',')}`,
          );
        }
        options.bundles = [...new Set(bundles)];
        break;
      }
      default:
        throw new Error(`Unknown build option: ${args[index]}`);
    }
  }
  return options;
}

export function rustupTarget(platform, arch) {
  if (!['x64', 'arm64'].includes(arch)) throw new Error('Unsupported CPU architecture');
  const cpu = arch === 'arm64' ? 'aarch64' : 'x86_64';
  const suffix = { win32: 'pc-windows-msvc', darwin: 'apple-darwin', linux: 'unknown-linux-gnu' }[
    platform
  ];
  if (!suffix) throw new Error('Unsupported Rust host');
  return `${cpu}-${suffix}`;
}

export function checksumFrom(text) {
  const hash = text.trim().split(/\s+/)[0];
  if (!/^[a-f\d]{64}$/i.test(hash)) throw new Error('Invalid official SHA-256 checksum');
  return hash.toLowerCase();
}
