/**
 * Excel workbooks (`.xlsx`, Office Open XML) written without a library: a sheet per table,
 * the first row with the names of the columns in bold and frozen, numbers and booleans as
 * such and everything else as text. Excel and LibreOffice open them. What does not fit in
 * a sheet (more than 1,048,576 rows or 16,384 columns, texts over 32,767 characters) is cut,
 * and the writer says so.
 */
import { cellText } from '../db/results';
import { escapeXml } from '../db/transfer/escape';
import { zip } from './zip';

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** Rows of data a sheet holds below its header. */
export const XLSX_MAX_ROWS = 1_048_575;
const MAX_COLUMNS = 16_384;
const MAX_TEXT = 32_767;

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE = 'http://schemas.openxmlformats.org/package/2006';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** The letters of a column: A, B, … Z, AA, AB… */
export function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** A name Excel accepts for a sheet: 31 characters without `[]:*?/\`, unique. */
function sheetNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((wanted, at) => {
    const base =
      wanted
        .replace(/[[\]:*?/\\]/g, ' ')
        .trim()
        .slice(0, 31) || `Sheet${at + 1}`;
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++)
      name = `${base.slice(0, 31 - String(n).length - 1)} ${n}`;
    used.add(name.toLowerCase());
    return name;
  });
}

/** One sheet being written, a page of rows at a time. */
export class XlsxSheet {
  private readonly parts: string[] = [];
  private written = 0;
  private readonly width: number;
  /** Whether something did not fit and was left out. */
  cut = false;

  constructor(
    readonly name: string,
    columns: readonly string[],
  ) {
    this.width = Math.min(columns.length, MAX_COLUMNS);
    this.cut = columns.length > MAX_COLUMNS;
    this.parts.push(this.row(1, columns, 1));
  }

  get rows() {
    return this.written;
  }

  add(rows: readonly (readonly unknown[])[]) {
    for (const row of rows) {
      if (this.written >= XLSX_MAX_ROWS) {
        this.cut = true;
        return;
      }
      this.written++;
      this.parts.push(this.row(this.written + 1, row));
    }
  }

  private row(number: number, cells: readonly unknown[], style = 0): string {
    let xml = `<row r="${number}">`;
    for (let at = 0; at < Math.min(cells.length, this.width); at++)
      xml += this.cell(`${columnName(at)}${number}`, cells[at], style);
    return `${xml}</row>`;
  }

  private cell(ref: string, value: unknown, style: number): string {
    const styled = style ? ` s="${style}"` : '';
    if (value === null || value === undefined) return '';
    if (typeof value === 'number' && Number.isFinite(value))
      return `<c r="${ref}"${styled}><v>${value}</v></c>`;
    if (typeof value === 'boolean')
      return `<c r="${ref}"${styled} t="b"><v>${value ? 1 : 0}</v></c>`;
    let text = typeof value === 'string' ? value : cellText(value);
    if (text.length > MAX_TEXT) {
      text = text.slice(0, MAX_TEXT);
      this.cut = true;
    }
    return `<c r="${ref}"${styled} t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
  }

  /** The XML of the sheet. */
  xml(): string {
    return (
      `${XML}<worksheet xmlns="${MAIN}"><sheetViews><sheetView workbookViewId="0">` +
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
      `</sheetView></sheetViews><sheetData>${this.parts.join('')}</sheetData></worksheet>`
    );
  }
}

const STYLES =
  `${XML}<styleSheet xmlns="${MAIN}">` +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

/** The workbook of some sheets, as the bytes of the file. */
export function workbook(sheets: readonly XlsxSheet[]): Uint8Array {
  const names = sheetNames(sheets.map((sheet) => sheet.name));
  const encoder = new TextEncoder();
  const file = (name: string, text: string) => ({ name, data: encoder.encode(text) });
  const overrides = sheets
    .map(
      (_, at) =>
        `<Override PartName="/xl/worksheets/sheet${at + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join('');
  return zip([
    file(
      '[Content_Types].xml',
      `${XML}<Types xmlns="${PACKAGE}/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        `${overrides}</Types>`,
    ),
    file(
      '_rels/.rels',
      `${XML}<Relationships xmlns="${PACKAGE}/relationships">` +
        `<Relationship Id="rId1" Type="${RELATIONSHIPS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    file(
      'xl/workbook.xml',
      `${XML}<workbook xmlns="${MAIN}" xmlns:r="${RELATIONSHIPS}"><sheets>` +
        names
          .map(
            (name, at) =>
              `<sheet name="${escapeXml(name)}" sheetId="${at + 1}" r:id="rId${at + 1}"/>`,
          )
          .join('') +
        '</sheets></workbook>',
    ),
    file(
      'xl/_rels/workbook.xml.rels',
      `${XML}<Relationships xmlns="${PACKAGE}/relationships">` +
        sheets
          .map(
            (_, at) =>
              `<Relationship Id="rId${at + 1}" Type="${RELATIONSHIPS}/worksheet" Target="worksheets/sheet${at + 1}.xml"/>`,
          )
          .join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="${RELATIONSHIPS}/styles" Target="styles.xml"/></Relationships>`,
    ),
    file('xl/styles.xml', STYLES),
    ...sheets.map((sheet, at) => file(`xl/worksheets/sheet${at + 1}.xml`, sheet.xml())),
  ]);
}

/** A workbook of one sheet with these columns and rows. */
export function xlsx(
  name: string,
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
): { bytes: Uint8Array; cut: boolean } {
  const sheet = new XlsxSheet(name, columns);
  sheet.add(rows);
  return { bytes: workbook([sheet]), cut: sheet.cut };
}
