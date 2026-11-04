import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { checksumFrom } from './plan.mjs';

export async function verifiedDownload(url, path, fetcher = fetch) {
  if (new URL(url).protocol !== 'https:') throw new Error('Tool downloads require HTTPS');
  const checksumResponse = await fetcher(`${url}.sha256`, { signal: AbortSignal.timeout(120000) });
  if (!checksumResponse.ok) throw new Error(`Cannot retrieve official checksum: ${url}`);
  const expected = checksumFrom(await checksumResponse.text());
  let bytes = existsSync(path) ? await readFile(path) : undefined;
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== expected) {
    const response = await fetcher(url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`Tool download failed: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (createHash('sha256').update(bytes).digest('hex') !== expected)
    throw new Error('Tool checksum mismatch; nothing was executed');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return path;
}
