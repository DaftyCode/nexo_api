/** CSV files of documents: rows written from fields, and read back in chunks. */
import { CsvColumn, cellText, isDocument, typedValue } from './cells';

/** A row of cells, quoted where a cell holds a separator, a quote, a line break or edge spaces. */
export function csvRow(cells: readonly string[]): string {
  return cells
    .map((cell) => (/[",\r\n]|^\s|\s$/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell))
    .join(',');
}

/** The value of a dotted field: `address.city` reads `city` of the document `address`. */
export function fieldValue(document: unknown, field: string): unknown {
  let value: unknown = document;
  for (const part of field.split('.')) {
    if (!isDocument(value)) return undefined;
    value = value[part];
  }
  return value;
}

/** The fields of documents, embedded documents flattened with dots, in the order first seen. */
export function documentFields(documents: readonly unknown[]): string[] {
  const fields: string[] = [];
  const visit = (value: Record<string, unknown>, prefix: string) => {
    for (const [key, inner] of Object.entries(value)) {
      const field = prefix + key;
      if (isDocument(inner) && Object.keys(inner).length) visit(inner, `${field}.`);
      else if (!fields.includes(field)) fields.push(field);
    }
  };
  for (const document of documents) if (isDocument(document)) visit(document, '');
  return fields;
}

/** A document as a CSV row of the given fields. */
export function csvRecord(document: unknown, fields: readonly string[]): string {
  return csvRow(fields.map((field) => cellText(fieldValue(document, field))));
}

/**
 * Reads CSV text given in chunks, as a file is read: quoted cells may hold separators and
 * line breaks, and a chunk may end anywhere, even inside a quote.
 */
export class CsvReader {
  private cell = '';
  private row: string[] = [];
  private quoted = false;
  /** A quote just closed a quoted cell, or starts an escaped quote. */
  private quote = false;
  private carriage = false;

  push(text: string): string[][] {
    const rows: string[][] = [];
    for (const character of text) {
      if (this.carriage) {
        this.carriage = false;
        if (character === '\n') continue;
      }
      if (this.quoted) {
        if (this.quote) {
          this.quote = false;
          if (character === '"') {
            this.cell += '"';
            continue;
          }
          this.quoted = false;
        } else if (character === '"') {
          this.quote = true;
          continue;
        } else {
          this.cell += character;
          continue;
        }
      }
      if (character === '"' && this.cell === '') this.quoted = true;
      else if (character === ',') this.endCell();
      else if (character === '\n' || character === '\r') {
        this.carriage = character === '\r';
        this.endCell();
        rows.push(this.endRow());
      } else this.cell += character;
    }
    return rows.filter((row) => row.length > 1 || row[0] !== '');
  }
  /** The last row, when the text does not end with a line break. */
  end(): string[][] {
    this.quote = false;
    this.quoted = false;
    if (this.cell === '' && !this.row.length) return [];
    this.endCell();
    const row = this.endRow();
    return row.length > 1 || row[0] !== '' ? [row] : [];
  }
  private endCell() {
    this.row.push(this.cell);
    this.cell = '';
  }
  private endRow() {
    const row = this.row;
    this.row = [];
    return row;
  }
}

/**
 * A row as a document: each column to its field (dotted fields build embedded documents),
 * with its type. The cells that cannot be read are reported by column.
 */
export function rowDocument(
  row: readonly string[],
  columns: readonly CsvColumn[],
): { document: Record<string, unknown>; errors: { column: string; type: string }[] } {
  const document: Record<string, unknown> = {};
  const errors: { column: string; type: string }[] = [];
  columns.forEach((column, index) => {
    const field = column.field.trim();
    if (!field || column.type === 'skip') return;
    const { value, error } = typedValue(row[index] ?? '', column.type);
    if (error) {
      errors.push({ column: column.column, type: error });
      return;
    }
    if (value === undefined) return;
    const parts = field.split('.');
    let parent = document;
    for (const part of parts.slice(0, -1)) {
      if (!isDocument(parent[part])) parent[part] = {};
      parent = parent[part] as Record<string, unknown>;
    }
    parent[parts[parts.length - 1]] = value;
  });
  return { document, errors };
}
