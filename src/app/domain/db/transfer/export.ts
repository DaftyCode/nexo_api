/**
 * Rows of a table or a query written as a file, a page at a time, as DBeaver's «Data
 * export»: CSV, JSON (an array or JSON Lines), SQL `INSERT`s (one row or many per statement,
 * after an optional `CREATE TABLE`), Markdown, HTML, XML and aligned text. Each writer gives
 * the start of the file, the text of each page and its end.
 */
import { ResultColumn, cellText, isNull } from '../results';
import { QuoteStyle, quoteName } from '../tree';
import { base64Bytes, classOf } from '../grid/cells';
import { SqlStyle, jsonValue, sqlLiteral } from '../grid/copy';
import { escapeHtml, escapeXml, markdownCell } from './escape';
import { XLSX_TYPE } from '../../export/xlsx';

/** The byte order mark some spreadsheets want first. */
export const BOM = String.fromCharCode(0xfeff);

export type ExportFormat = 'csv' | 'json' | 'jsonl' | 'sql' | 'markdown' | 'html' | 'xml' | 'text';

export const EXPORT_FORMATS: readonly ExportFormat[] = [
  'csv',
  'json',
  'jsonl',
  'sql',
  'markdown',
  'html',
  'xml',
  'text',
];
export const EXPORT_EXTENSIONS: Record<ExportFormat, string> = {
  csv: 'csv',
  json: 'json',
  jsonl: 'jsonl',
  sql: 'sql',
  markdown: 'md',
  html: 'html',
  xml: 'xml',
  text: 'txt',
};
export const EXPORT_TYPES: Record<ExportFormat, string> = {
  csv: 'text/csv',
  json: 'application/json',
  jsonl: 'application/x-ndjson',
  sql: 'application/sql',
  markdown: 'text/markdown',
  html: 'text/html',
  xml: 'application/xml',
  text: 'text/plain',
};

/** What an export writes: a format of the writers, or an Excel workbook (B-06). */
export type FileFormat = ExportFormat | 'xlsx';
export const FILE_FORMATS: readonly FileFormat[] = [
  'csv',
  'xlsx',
  ...EXPORT_FORMATS.filter((format) => format !== 'csv'),
];
export const FILE_EXTENSIONS: Record<FileFormat, string> = { ...EXPORT_EXTENSIONS, xlsx: 'xlsx' };
export const FILE_TYPES: Record<FileFormat, string> = { ...EXPORT_TYPES, xlsx: XLSX_TYPE };

/**
 * The format `@export` names: a format's name (`@export csv`), or DBeaver's JSON with its
 * `type` or `format` (`@export {"type": "json"}`).
 */
export function exportFormatOf(options: string): ExportFormat | undefined {
  let name = options.trim().toLowerCase();
  if (name.startsWith('{')) {
    try {
      const read = JSON.parse(options) as { type?: unknown; format?: unknown };
      name = String(read.format ?? read.type ?? '').toLowerCase();
    } catch {
      return undefined;
    }
  }
  if (name === '') return 'csv';
  return EXPORT_FORMATS.find((format) => format === name);
}

export interface ExportOptions {
  /** CSV: the separator, `,` `;` or a tab. */
  separator: string;
  /** CSV: a first line with the names of the columns. */
  header: boolean;
  /** CSV, Markdown, HTML, XML and text: how `NULL` is written. */
  nullText: string;
  /** A byte order mark first, for the spreadsheets that want one. */
  bom: boolean;
  /** SQL: rows in each `INSERT`. */
  rowsPerInsert: number;
  /** Binary values: as Base64, as hexadecimal or as `NULL`. */
  binary: 'base64' | 'hex' | 'null';
}

export function defaultExportOptions(): ExportOptions {
  return {
    separator: ',',
    header: true,
    nullText: '',
    bom: false,
    rowsPerInsert: 1,
    binary: 'base64',
  };
}

/** What a writer needs besides the rows: the columns, and for SQL the table and dialect. */
export interface ExportShape {
  columns: readonly ResultColumn[];
  /** SQL: the table the `INSERT`s write, as the dialect names it. */
  table: string;
  style: SqlStyle;
  /** SQL: a `CREATE TABLE` written before the rows. */
  ddl?: string;
}

export interface ExportWriter {
  start(): string;
  page(rows: readonly (readonly unknown[])[]): string;
  end(): string;
}

/** A binary value as the options ask; any other value unchanged. */
function binaryAs(value: unknown, options: ExportOptions): unknown {
  if (isNull(value) || classOf(value) !== 'binary' || options.binary === 'base64') return value;
  if (options.binary === 'null') return null;
  const bytes = base64Bytes(String((value as { v?: unknown }).v ?? ''));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function text(value: unknown, options: ExportOptions): string {
  const shown = binaryAs(value, options);
  return isNull(shown) ? options.nullText : cellText(shown);
}

function csvCell(cell: string, separator: string): string {
  return cell.includes(separator) || /["\r\n]|^\s|\s$/.test(cell)
    ? `"${cell.replace(/"/g, '""')}"`
    : cell;
}

/** The writer of a format. */
export function exportWriter(
  format: ExportFormat,
  shape: ExportShape,
  options: ExportOptions,
): ExportWriter {
  const names = shape.columns.map((column) => column.name);
  const bom = options.bom ? BOM : '';
  let written = 0;
  const object = (row: readonly unknown[]) =>
    Object.fromEntries(names.map((name, at) => [name, jsonValue(binaryAs(row[at], options))]));
  switch (format) {
    case 'csv': {
      const line = (cells: readonly string[]) =>
        cells.map((cell) => csvCell(cell, options.separator)).join(options.separator);
      return {
        start: () => bom + (options.header ? line(names) + '\n' : ''),
        page: (rows) => rows.map((row) => line(row.map((v) => text(v, options))) + '\n').join(''),
        end: () => '',
      };
    }
    case 'json':
      return {
        start: () => `${bom}[`,
        page: (rows) =>
          rows.map((row) => `${written++ ? ',' : ''}\n  ${JSON.stringify(object(row))}`).join(''),
        end: () => (written ? '\n]\n' : ']\n'),
      };
    case 'jsonl':
      return {
        start: () => bom,
        page: (rows) => rows.map((row) => JSON.stringify(object(row)) + '\n').join(''),
        end: () => '',
      };
    case 'sql':
      return sqlWriter(shape, options, bom);
    case 'markdown':
      return {
        start: () =>
          `${bom}| ${names.map(markdownCell).join(' | ')} |\n|${names.map(() => ' --- ').join('|')}|\n`,
        page: (rows) =>
          rows
            .map((row) => `| ${row.map((v) => markdownCell(text(v, options))).join(' | ')} |\n`)
            .join(''),
        end: () => '',
      };
    case 'html':
      return {
        start: () =>
          `${bom}<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>${escapeHtml(shape.table)}</title></head><body>\n<table>\n<thead><tr>${names.map((name) => `<th>${escapeHtml(name)}</th>`).join('')}</tr></thead>\n<tbody>\n`,
        page: (rows) =>
          rows
            .map(
              (row) =>
                `<tr>${row.map((v) => `<td>${escapeHtml(text(v, options))}</td>`).join('')}</tr>\n`,
            )
            .join(''),
        end: () => '</tbody>\n</table>\n</body></html>\n',
      };
    case 'xml':
      return {
        start: () =>
          `${bom}<?xml version="1.0" encoding="UTF-8"?>\n<rows table="${escapeXml(shape.table)}">\n`,
        page: (rows) =>
          rows
            .map(
              (row) =>
                `  <row>${row
                  .map((v, at) =>
                    isNull(v)
                      ? `<column name="${escapeXml(names[at])}" null="true"/>`
                      : `<column name="${escapeXml(names[at])}">${escapeXml(text(v, options))}</column>`,
                  )
                  .join('')}</row>\n`,
            )
            .join(''),
        end: () => '</rows>\n',
      };
    case 'text':
      return textWriter(names, options, bom);
  }
}

function sqlWriter(shape: ExportShape, options: ExportOptions, bom: string): ExportWriter {
  const style: QuoteStyle & SqlStyle = shape.style;
  const columns = shape.columns.map((column) => quoteName(column.name, style)).join(', ');
  const head = `INSERT INTO ${shape.table} (${columns}) VALUES`;
  const per = Math.min(1000, Math.max(1, Math.floor(options.rowsPerInsert) || 1));
  const values = (row: readonly unknown[]) =>
    `(${row.map((value) => sqlLiteral(binaryAs(value, options), style)).join(', ')})`;
  return {
    start: () => bom + (shape.ddl ? `${shape.ddl.trim().replace(/;$/, '')};\n\n` : ''),
    page: (rows) => {
      const statements: string[] = [];
      for (let at = 0; at < rows.length; at += per) {
        const group = rows.slice(at, at + per).map(values);
        statements.push(per === 1 ? `${head} ${group[0]};` : `${head}\n  ${group.join(',\n  ')};`);
      }
      return statements.map((statement) => statement + '\n').join('');
    },
    end: () => '',
  };
}

/** Aligned text: the widths of the first page hold for the rest, cut at 60 characters. */
function textWriter(names: readonly string[], options: ExportOptions, bom: string): ExportWriter {
  let widths: number[] | undefined;
  const line = (cells: readonly string[]) =>
    cells.map((cell, at) => cell.slice(0, widths![at]).padEnd(widths![at])).join(' | ');
  return {
    start: () => bom,
    page: (rows) => {
      const cells = rows.map((row) => row.map((v) => text(v, options).replace(/\s+/g, ' ')));
      let head = '';
      if (!widths) {
        widths = names.map((name, at) =>
          Math.min(60, Math.max(name.length, ...cells.map((row) => row[at]?.length ?? 0))),
        );
        head = `${line(names)}\n${widths.map((width) => '-'.repeat(width)).join('-+-')}\n`;
      }
      return head + cells.map((row) => line(row) + '\n').join('');
    },
    end: () => (widths ? '' : `${names.join(' | ')}\n`),
  };
}
