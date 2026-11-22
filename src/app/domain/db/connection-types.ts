/**
 * The types of SQL connections (DB-25), as DBeaver's: development, test and production, and
 * the person's own (`connection-type` documents) with their color and what their sessions do.
 * The engine applies the same rules; the interface reads them to ask before it sends.
 */
import type { WorkspaceDocument } from '../models';

/** What a type asks of every session of its connections. */
export interface TypeRules {
  autoCommit: boolean;
  /** Each statement that writes or changes structure is confirmed. */
  confirmWrites: boolean;
  /** Each statement that changes structure (DDL) is confirmed. */
  confirmStructure: boolean;
  readOnly: boolean;
  /** The longest a statement may run, when the connection says nothing. */
  timeoutSeconds?: number;
}

/** A type a connection may have: built in, or one of the person's own. */
export interface ConnectionTypeChoice {
  /** `development`, `test`, `production`, or the id of the document. */
  id: string;
  /** A message key for the built-in ones, the person's name for theirs. */
  name: string;
  /** A color of the connection palette; none for the built-in ones but production. */
  color: string;
  builtin: boolean;
  rules: TypeRules;
}

const permissive: TypeRules = {
  autoCommit: true,
  confirmWrites: false,
  confirmStructure: false,
  readOnly: false,
};

export const BUILTIN_TYPES: readonly ConnectionTypeChoice[] = [
  { id: 'development', name: 'db.type.development', color: '', builtin: true, rules: permissive },
  { id: 'test', name: 'db.type.test', color: '', builtin: true, rules: permissive },
  {
    id: 'production',
    name: 'db.type.production',
    color: 'production',
    builtin: true,
    rules: { ...permissive, autoCommit: false, confirmWrites: true, confirmStructure: true },
  },
];

const flag = (value: unknown) => value === true;

/** A type of the person's own, read from its document; anything else is not one. */
export function readConnectionType(document: WorkspaceDocument): ConnectionTypeChoice | undefined {
  if (document.kind !== 'connection-type') return undefined;
  const value = (document.value ?? {}) as Record<string, unknown>;
  const timeout = value['timeoutSeconds'];
  return {
    id: document.id,
    name: document.name,
    color: typeof value['color'] === 'string' ? value['color'] : '',
    builtin: false,
    rules: {
      autoCommit: flag(value['autoCommit']),
      confirmWrites: flag(value['confirmWrites']),
      confirmStructure: flag(value['confirmStructure']),
      readOnly: flag(value['readOnly']),
      ...(typeof timeout === 'number' && timeout > 0 ? { timeoutSeconds: timeout } : {}),
    },
  };
}

/** The types a connection may choose: the built-in ones first, then the person's by name. */
export function connectionTypes(documents: readonly WorkspaceDocument[]): ConnectionTypeChoice[] {
  const own = documents
    .map(readConnectionType)
    .filter((type): type is ConnectionTypeChoice => !!type)
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...BUILTIN_TYPES, ...own];
}

/**
 * The type a connection names among those that exist. One of the person's own that no longer
 * exists keeps every confirmation, as production's, until another one is chosen (the engine
 * refuses to connect it).
 */
export function typeOf(
  type: string | undefined,
  documents: readonly WorkspaceDocument[],
): ConnectionTypeChoice {
  const id = type || 'development';
  const found = connectionTypes(documents).find((choice) => choice.id === id);
  return found ?? { ...BUILTIN_TYPES[2], id, name: id, builtin: false };
}

/** The form of a type of the person's own. */
export interface ConnectionTypeForm {
  name: string;
  color: string;
  autoCommit: boolean;
  confirmWrites: boolean;
  confirmStructure: boolean;
  readOnly: boolean;
  /** 0: no limit of its own. */
  timeoutSeconds: number;
}

export function connectionTypeForm(type?: ConnectionTypeChoice): ConnectionTypeForm {
  const rules = type?.rules ?? permissive;
  return {
    name: type?.name ?? '',
    color: type?.color ?? '',
    autoCommit: rules.autoCommit,
    confirmWrites: rules.confirmWrites,
    confirmStructure: rules.confirmStructure,
    readOnly: rules.readOnly,
    timeoutSeconds: rules.timeoutSeconds ?? 0,
  };
}

/** What keeps the form from being saved, as a message key; empty when nothing. */
export function connectionTypeProblem(form: ConnectionTypeForm): string {
  if (!form.name.trim()) return 'Give the type a name';
  const timeout = form.timeoutSeconds;
  if (timeout !== 0 && !(Number.isInteger(timeout) && timeout >= 1 && timeout <= 3600))
    return 'The statement time limit is from 1 to 3600 seconds';
  return '';
}

/** The value stored for a type of the person's own. */
export function connectionTypeValue(form: ConnectionTypeForm): Record<string, unknown> {
  return {
    ...(form.color ? { color: form.color } : {}),
    autoCommit: form.autoCommit,
    confirmWrites: form.confirmWrites,
    confirmStructure: form.confirmStructure,
    readOnly: form.readOnly,
    ...(form.timeoutSeconds > 0 ? { timeoutSeconds: form.timeoutSeconds } : {}),
  };
}
