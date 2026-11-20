import { unzip } from '../../testing/unzip';
import { crc32, zip } from './zip';

describe('zip', () => {
  it('computes the CRC-32 of the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('stores files that read back with their names, also in UTF-8', () => {
    const encoder = new TextEncoder();
    const archive = zip([
      { name: 'a.txt', data: encoder.encode('hello') },
      { name: 'carpeta/año.xml', data: encoder.encode('<x>ñ</x>') },
      { name: 'empty', data: new Uint8Array() },
    ]);
    const files = unzip(archive);
    expect([...files.keys()]).toEqual(['a.txt', 'carpeta/año.xml', 'empty']);
    expect(files.get('carpeta/año.xml')).toBe('<x>ñ</x>');
    expect(files.get('empty')).toBe('');
    // The same files make the same archive.
    expect(zip([{ name: 'a.txt', data: encoder.encode('hello') }])).toEqual(
      zip([{ name: 'a.txt', data: encoder.encode('hello') }]),
    );
  });

  it('writes an empty archive as its end record alone', () => {
    const archive = zip([]);
    expect(archive.length).toBe(22);
    expect(unzip(archive).size).toBe(0);
  });
});
