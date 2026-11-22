/**
 * What an import of connections brings (DB-25), collected as each reader finds it: the
 * documents with their ids, what did not come and the notes of the report.
 */
import { sshSecret } from '../../ssh';
import type { DbConnectionValue } from '../connection';

export type ImportSource = 'dbeaver' | 'pgadmin' | 'workbench' | 'urls' | 'nexo';

/** What the report notes, each one with the connections it is about. */
export const CONNECTION_IMPORT_NOTES = [
  'password',
  'user',
  'sshPassword',
  'sshKey',
  'proxyPassword',
  'type',
  'passFile',
  'tlsFiles',
] as const;
export type ConnectionImportNote = (typeof CONNECTION_IMPORT_NOTES)[number];
/** Why a connection did not come. */
export type SkipReason = 'engine' | 'socket' | 'url';

/** A document the import creates: connections and what they name (profiles, types). */
export interface ImportedDocument {
  id: string;
  kind: 'connection' | 'ssh-profile' | 'proxy-profile' | 'connection-type';
  name: string;
  value: Record<string, unknown>;
}

export interface ConnectionImport {
  source: ImportSource;
  /** In the order they are saved: what connections name first. */
  documents: ImportedDocument[];
  skipped: { name: string; reason: SkipReason }[];
  notes: { code: ConnectionImportNote; items: string[] }[];
}

/** The most connections one import brings, and the largest file it reads. */
export const IMPORT_MAX_CONNECTIONS = 500;
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;

/** The module of an engine other tools name: Nexo's ids, none for those it has no module of. */
export function engineOf(name: string): string {
  const text = name.toLowerCase();
  if (text.includes('sqlite')) return 'sqlite';
  if (/postgre|redshift/.test(text)) return text.includes('redshift') ? '' : 'postgres';
  if (/mysql|maria/.test(text)) return 'mysql';
  if (/sqlserver|mssql|jtds/.test(text)) return 'mssql';
  return '';
}

/** Collects what an import brings, giving each document an id of `newId`. */
export class ImportBuilder {
  private readonly documents: ImportedDocument[] = [];
  private readonly skipped: { name: string; reason: SkipReason }[] = [];
  private readonly noted = new Map<ConnectionImportNote, string[]>();
  private readonly bastions = new Map<string, string>();

  constructor(
    private readonly source: ImportSource,
    readonly newId: () => string,
  ) {}

  note(code: ConnectionImportNote, item: string) {
    const items = this.noted.get(code) ?? [];
    if (!items.includes(item)) items.push(item);
    this.noted.set(code, items);
  }
  skip(name: string, reason: SkipReason) {
    this.skipped.push({ name, reason });
  }
  /** Adds a document as it is; the caller gives its id. */
  add(document: ImportedDocument) {
    this.documents.push(document);
  }

  /**
   * The SSH profile of a bastion, one per host, port and user. Its password or key is not in
   * the file: the person writes it in Settings → SSH.
   */
  ssh(host: string, port: number, username: string, key: boolean, connection: string): string {
    const found = `${username}@${host}:${port}`;
    this.note(key ? 'sshKey' : 'sshPassword', connection);
    const kept = this.bastions.get(found);
    if (kept) return kept;
    const id = this.newId();
    this.bastions.set(found, id);
    this.add({
      id,
      kind: 'ssh-profile',
      name: found,
      value: { host, port, username, auth: key ? 'key' : 'password', secret: sshSecret(id) },
    });
    return id;
  }

  /**
   * A connection. One with a user and no other source of its password asks for it when it
   * opens, since no password comes with it.
   */
  connection(name: string, value: DbConnectionValue) {
    if (this.connections() >= IMPORT_MAX_CONNECTIONS) return;
    const kept: DbConnectionValue = { ...value };
    if (kept.user && !kept.pgpass && !kept.password) {
      kept.askPassword = true;
      this.note('password', name);
    }
    for (const key of Object.keys(kept) as (keyof DbConnectionValue)[])
      if (kept[key] === undefined || kept[key] === '') delete kept[key];
    this.add({
      id: this.newId(),
      kind: 'connection',
      name,
      value: kept as unknown as Record<string, unknown>,
    });
  }
  connections() {
    return this.documents.filter((document) => document.kind === 'connection').length;
  }

  result(): ConnectionImport {
    return {
      source: this.source,
      documents: this.documents,
      skipped: this.skipped,
      notes: CONNECTION_IMPORT_NOTES.filter((code) => this.noted.has(code)).map((code) => ({
        code,
        items: this.noted.get(code)!,
      })),
    };
  }
}
