import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { generatePackageManifests } from './package-manifests.mjs';

test('package manifests use actual artifact checksums, valid architectures and encoded release URLs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexo-packages-'));
  try {
    const artifacts = join(directory, 'inputs'),
      output = join(directory, 'outputs');
    await mkdir(artifacts);
    const names = [
      'Nexo API_0.1.0_x64_en-US.msi',
      'Nexo API_0.1.0_aarch64.dmg',
      'Nexo API_0.1.0_x64.dmg',
      'Nexo API_0.1.0_amd64.deb',
      'Nexo API-0.1.0-1.x86_64.rpm',
    ];
    for (const name of names) await writeFile(join(artifacts, name), `fixture:${name}`);
    const result = await generatePackageManifests({
      artifacts,
      output,
      version: '0.1.0',
      repository: 'DaftyCode/nexo_api',
    });
    assert.equal(result.assets, 5);
    const manifest = parse(
      await readFile(
        join(output, 'winget/manifests/d/DaftyCode/NexoAPI/0.1.0/DaftyCode.NexoAPI.installer.yaml'),
        'utf8',
      ),
    );
    assert.equal(manifest.Installers[0].Architecture, 'x64');
    assert.equal(
      manifest.Installers[0].InstallerSha256,
      createHash('sha256').update(`fixture:${names[0]}`).digest('hex').toUpperCase(),
    );
    assert.ok(manifest.Installers[0].InstallerUrl.endsWith('Nexo%20API_0.1.0_x64_en-US.msi'));
    const cask = await readFile(join(output, 'Casks/nexo-api.rb'), 'utf8');
    assert.ok(cask.includes('on_arm do') && cask.includes('on_intel do'));
    assert.ok(!cask.includes(':no_check'));
    await rm(join(artifacts, names[1]));
    await assert.rejects(
      () =>
        generatePackageManifests({
          artifacts,
          output,
          version: '0.1.0',
          repository: 'DaftyCode/nexo_api',
        }),
      /both macOS architectures/,
    );
    await assert.rejects(
      () =>
        generatePackageManifests({
          artifacts,
          output,
          version: '../../invalid',
          repository: 'DaftyCode/nexo_api',
        }),
      /semantic version/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
