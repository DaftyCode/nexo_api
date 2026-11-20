import { crc32 } from '../domain/export/zip';

/** The files of a stored archive, read back through its central directory. */
export function unzip(archive: Uint8Array): Map<string, string> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const end = archive.length - 22;
  if (view.getUint32(end, true) !== 0x06054b50) throw new Error('No end record');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const files = new Map<string, string>();
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('No central record');
    const size = view.getUint32(at + 20, true);
    const crc = view.getUint32(at + 16, true);
    const nameLength = view.getUint16(at + 28, true);
    const offset = view.getUint32(at + 42, true);
    const name = decoder.decode(archive.subarray(at + 46, at + 46 + nameLength));
    if (view.getUint32(offset, true) !== 0x04034b50) throw new Error('No local header');
    const start = offset + 30 + view.getUint16(offset + 26, true);
    const data = archive.subarray(start, start + size);
    if (crc32(data) !== crc) throw new Error(`Bad CRC of ${name}`);
    files.set(name, decoder.decode(data));
    at += 46 + nameLength;
  }
  return files;
}
