/** The database use cases on a fake engine, for their specs: what each operation answers. */
import type { DatabasePorts } from '../application/database-use-cases';
import { DatabaseUseCases } from '../application/database-use-cases';
import type { StatementPorts } from '../application/database-use-cases/statements';
import type { TransferTarget } from '../application/ports';
import { WorkspaceDocument } from '../domain/models';

export type Answer = unknown | ((payload: Record<string, unknown>) => unknown);

export function databaseCases(answers: Record<string, Answer> = {}) {
  const calls: [string, Record<string, unknown>][] = [];
  const preferences = new Map<string, string>();
  const removedSecrets: string[] = [];
  const saved: WorkspaceDocument[] = [];
  const api = {
    execute: async (operation: string, payload: Record<string, unknown>) => {
      calls.push([operation, payload]);
      const answer = answers[operation];
      return typeof answer === 'function' ? answer(payload) : answer;
    },
    save: async (document: WorkspaceDocument) => {
      saved.push(document);
      return document;
    },
    remove: async () => undefined,
    removeSecret: async (name: string) => {
      removedSecrets.push(name);
      throw new Error('already gone');
    },
  } as unknown as DatabasePorts & StatementPorts;
  const cases = new DatabaseUseCases(api, {
    read: (key) => preferences.get(key),
    write: (key, value) => void preferences.set(key, value),
  });
  const named = (operation: string) =>
    calls.filter(([name]) => name === operation).map(([, payload]) => payload);
  return { cases, calls, named, preferences, removedSecrets, saved };
}

export function targetFile(): TransferTarget & {
  text: string;
  closed: boolean;
  discarded: boolean;
} {
  const file = {
    name: 'out.csv',
    text: '',
    closed: false,
    discarded: false,
    write: async (text: string) => void (file.text += text),
    close: async () => void (file.closed = true),
    discard: async () => void (file.discarded = true),
  };
  return file;
}
export const never = new AbortController().signal;
export const write = { workspace: 'w', session: 's', table: 't', mode: 'insert' as const, key: [] };
export const written = { inserted: 1, upserted: 0, failed: 0, failures: [] };
