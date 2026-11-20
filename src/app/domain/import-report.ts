/**
 * What an import from another API client brought (B-07): how many requests, folders and
 * environments, and notes on what could not come as it was, each with a code the
 * interface translates (`import.note.<code>`) and the request, folder or environment it is
 * about.
 */

/** The tools Nexo imports from, by the name the engine gives them. */
export const IMPORT_SOURCES: Readonly<Record<string, string>> = {
  insomnia: 'Insomnia',
  bruno: 'Bruno',
  hoppscotch: 'Hoppscotch',
  thunder: 'Thunder Client',
};

/** The notes an import can leave, in the order they are listed. */
export const IMPORT_NOTES = [
  'script',
  'vars',
  'tests',
  'file',
  'privateKey',
  'secret',
  'templateTag',
  'auth',
  'unsupported',
  'spec',
] as const;
export type ImportNoteCode = (typeof IMPORT_NOTES)[number];

export interface ImportReport {
  /** The name of the tool, as it is written. */
  source: string;
  requests: number;
  folders: number;
  environments: number;
  /** The notes, a code at a time, with what each one is about. */
  notes: { code: ImportNoteCode; items: string[] }[];
}

const count = (value: unknown) => (typeof value === 'number' && value >= 0 ? value : 0);

/** The report of an import, when the engine gave one; notes of codes it does not know are left out. */
export function readImportReport(value: unknown): ImportReport | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const report = value as Record<string, unknown>;
  const source = IMPORT_SOURCES[String(report['source'])];
  if (!source) return undefined;
  const notes = Array.isArray(report['notes']) ? (report['notes'] as unknown[]) : [];
  const items = new Map<ImportNoteCode, string[]>();
  for (const note of notes) {
    const { code, item } = (note ?? {}) as Record<string, unknown>;
    if (!IMPORT_NOTES.includes(code as ImportNoteCode)) continue;
    const list = items.get(code as ImportNoteCode) ?? [];
    list.push(String(item ?? ''));
    items.set(code as ImportNoteCode, list);
  }
  return {
    source,
    requests: count(report['requests']),
    folders: count(report['folders']),
    environments: count(report['environments']),
    notes: IMPORT_NOTES.filter((code) => items.has(code)).map((code) => ({
      code,
      items: items.get(code) ?? [],
    })),
  };
}

/** Files of a Bruno collection folder, at most; the engine refuses more. */
export const BRUNO_MAX_FILES = 5000;
/** Size of a file of the folder that is read, at most. */
export const BRUNO_MAX_FILE = 1_000_000;

/**
 * Whether a file of a chosen folder is part of a Bruno collection: its `.bru` files,
 * `bruno.json` and the key files OAuth 1.0 requests name; never what is inside
 * `node_modules` or hidden folders.
 */
export function brunoFile(path: string, size: number): boolean {
  const parts = path.replace(/\\/g, '/').split('/');
  const name = parts.at(-1) ?? '';
  if (size > BRUNO_MAX_FILE) return false;
  if (parts.slice(0, -1).some((part) => part === 'node_modules' || part.startsWith('.')))
    return false;
  return name === 'bruno.json' || /\.(bru|pem|key)$/i.test(name);
}
