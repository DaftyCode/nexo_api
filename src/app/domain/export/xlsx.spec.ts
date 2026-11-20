import { XLSX_TYPE, XlsxSheet, columnName, workbook, xlsx } from './xlsx';
import { unzip } from '../../testing/unzip';

describe('xlsx', () => {
  it('names columns as spreadsheets do', () => {
    expect([0, 1, 25, 26, 27, 701, 702].map(columnName)).toEqual([
      'A',
      'B',
      'Z',
      'AA',
      'AB',
      'ZZ',
      'AAA',
    ]);
  });

  it('writes a workbook with every part Excel and LibreOffice need', () => {
    const { bytes, cut } = xlsx(
      'Orders',
      ['id', 'name', 'paid', 'note'],
      [
        [1, 'Ana <&> "Real"', true, null],
        [2.5, 'Luis', false, { $t: 'decimal', v: '9.10' }],
        [Number.NaN, 'x\u0001y', undefined, ['a', 'b']],
      ],
    );
    expect(cut).toBe(false);
    expect(XLSX_TYPE).toContain('spreadsheetml.sheet');
    const files = unzip(bytes);
    expect([...files.keys()]).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
    ]);
    expect(files.get('[Content_Types].xml')).toContain('/xl/worksheets/sheet1.xml');
    expect(files.get('xl/workbook.xml')).toContain(
      '<sheet name="Orders" sheetId="1" r:id="rId1"/>',
    );
    expect(files.get('xl/_rels/workbook.xml.rels')).toContain('Target="styles.xml"');
    const sheet = files.get('xl/worksheets/sheet1.xml')!;
    // The header in bold, and frozen.
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">id</t>');
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toContain('<c r="A2"><v>1</v></c>');
    expect(sheet).toContain('<c r="C2" t="b"><v>1</v></c>');
    expect(sheet).toContain('Ana &lt;&amp;&gt; &quot;Real&quot;');
    // NULL leaves the cell empty; typed values of a database by what they hold.
    expect(sheet).not.toContain('r="D2"');
    expect(sheet).toContain('<t xml:space="preserve">9.10</t>');
    // A number that is not finite is text, control characters are dropped.
    expect(sheet).toContain('<t xml:space="preserve">NaN</t>');
    expect(sheet).toContain('<t xml:space="preserve">xy</t>');
    expect(sheet).toContain('<t xml:space="preserve">[a, b]</t>');
  });

  it('cuts what does not fit in a sheet, and says so', () => {
    const long = new XlsxSheet('Long', ['text']);
    long.add([['x'.repeat(40_000)]]);
    expect(long.cut).toBe(true);
    expect(long.rows).toBe(1);
    expect(long.xml()).toContain('x'.repeat(32_767) + '</t>');
    expect(long.xml()).not.toContain('x'.repeat(32_768));
    const wide = new XlsxSheet(
      'Wide',
      Array.from({ length: 16_385 }, (_, at) => `c${at}`),
    );
    expect(wide.cut).toBe(true);
    expect(wide.xml()).toContain('r="XFD1"');
    expect(wide.xml()).not.toContain('c16384');
  });

  it('gives each sheet a name Excel accepts, once', () => {
    const files = unzip(
      workbook([
        new XlsxSheet('a/b:c*d?[e]', ['x']),
        new XlsxSheet('A/B:C*D?[E]', ['x']),
        new XlsxSheet('', ['x']),
        new XlsxSheet('n'.repeat(40), ['x']),
      ]),
    );
    const names = [...files.get('xl/workbook.xml')!.matchAll(/name="([^"]*)"/g)].map(
      (match) => match[1],
    );
    expect(names).toEqual(['a b c d  e', 'A B C D  E 2', 'Sheet3', 'n'.repeat(31)]);
    expect(files.has('xl/worksheets/sheet4.xml')).toBe(true);
  });
});
