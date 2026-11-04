import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { verifiedDownload } from './download.mjs';

test('rejects corrupt downloads and replaces corrupt cached installers only after verification', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexo-bootstrap-'));
  const path = join(directory, 'installer');
  const bytes = Buffer.from('official fixture');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const url = 'https://example.test/rustup-init';
  try {
    await assert.rejects(
      verifiedDownload(
        url,
        path,
        async (request) => new Response(request.endsWith('.sha256') ? hash : 'corrupt'),
      ),
      /checksum mismatch/,
    );
    assert.equal(existsSync(path), false);
    await writeFile(path, 'corrupt cache');
    let artifactDownloads = 0;
    const fetcher = async (request) => {
      if (request.endsWith('.sha256')) return new Response(`${hash}  rustup-init`);
      artifactDownloads++;
      return new Response(bytes);
    };
    await verifiedDownload(url, path, fetcher);
    assert.deepEqual(await readFile(path), bytes);
    await verifiedDownload(url, path, fetcher);
    assert.equal(artifactDownloads, 1);
    await assert.rejects(verifiedDownload('http://example.test/tool', path, fetcher), /HTTPS/);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});
