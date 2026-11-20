/**
 * A ZIP archive of stored (uncompressed) files, the container of an Excel workbook. Stored
 * entries need no compression library, and Excel and LibreOffice read them as any other.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The CRC-32 of some bytes, as ZIP and PNG compute it. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** 1980-01-01 00:00, the first date ZIP can write: the same archive for the same files. */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;
/** Bit 11: names in UTF-8. */
const UTF8 = 0x0800;

/** The archive of `entries`, in their order. */
export function zip(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;
    const local = new Uint8Array(30 + name.length);
    const head = new DataView(local.buffer);
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, UTF8, true);
    head.setUint16(8, 0, true);
    head.setUint16(10, DOS_TIME, true);
    head.setUint16(12, DOS_DATE, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, size, true);
    head.setUint32(22, size, true);
    head.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const record = new DataView(central.buffer);
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, 20, true);
    record.setUint16(6, 20, true);
    record.setUint16(8, UTF8, true);
    record.setUint16(10, 0, true);
    record.setUint16(12, DOS_TIME, true);
    record.setUint16(14, DOS_DATE, true);
    record.setUint32(16, crc, true);
    record.setUint32(20, size, true);
    record.setUint32(24, size, true);
    record.setUint16(28, name.length, true);
    record.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, entry.data);
    centrals.push(central);
    offset += local.length + size;
  }
  const directory = centrals.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  const tail = new DataView(end.buffer);
  tail.setUint32(0, 0x06054b50, true);
  tail.setUint16(8, entries.length, true);
  tail.setUint16(10, entries.length, true);
  tail.setUint32(12, directory, true);
  tail.setUint32(16, offset, true);
  const archive = new Uint8Array(offset + directory + end.length);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    archive.set(part, at);
    at += part.length;
  }
  return archive;
}
