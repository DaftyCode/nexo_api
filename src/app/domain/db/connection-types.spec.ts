import { describe, expect, it } from 'vitest';
import type { WorkspaceDocument } from '../models';
import {
  connectionTypeForm,
  connectionTypeProblem,
  connectionTypeValue,
  connectionTypes,
  readConnectionType,
  typeOf,
} from './connection-types';

const own = (id: string, name: string, value: unknown): WorkspaceDocument => ({
  id,
  workspace_id: 'w',
  kind: 'connection-type',
  name,
  revision: 1,
  updated_at: 0,
  value,
});

describe('connection types', () => {
  it("offers the built-in types first and the person's own by name", () => {
    const documents = [
      own('t2', 'Staging', { color: '#d4a72c', confirmStructure: true, timeoutSeconds: 30 }),
      own('t1', 'QA', { autoCommit: true, readOnly: true }),
      { ...own('c', 'Shop', {}), kind: 'connection' },
    ];
    expect(connectionTypes(documents).map((type) => type.id)).toEqual([
      'development',
      'test',
      'production',
      't1',
      't2',
    ]);
    expect(readConnectionType(documents[0])).toEqual({
      id: 't2',
      name: 'Staging',
      color: '#d4a72c',
      builtin: false,
      rules: {
        autoCommit: false,
        confirmWrites: false,
        confirmStructure: true,
        readOnly: false,
        timeoutSeconds: 30,
      },
    });
    expect(readConnectionType(documents[2])).toBeUndefined();
    expect(typeOf(undefined, documents).id).toBe('development');
    expect(typeOf('production', documents).rules.confirmWrites).toBe(true);
    expect(typeOf('t1', documents).rules.readOnly).toBe(true);
    // A type that no longer exists keeps every confirmation.
    const gone = typeOf('deleted', documents);
    expect(gone).toMatchObject({ id: 'deleted', builtin: false });
    expect(gone.rules).toMatchObject({ confirmWrites: true, autoCommit: false });
  });

  it('writes the form of a type of your own and says what keeps it from being saved', () => {
    const form = { ...connectionTypeForm(), name: 'Staging', confirmWrites: true };
    expect(connectionTypeValue(form)).toEqual({
      autoCommit: true,
      confirmWrites: true,
      confirmStructure: false,
      readOnly: false,
    });
    expect(connectionTypeValue({ ...form, color: 'x', timeoutSeconds: 20 })).toMatchObject({
      color: 'x',
      timeoutSeconds: 20,
    });
    expect(connectionTypeProblem(form)).toBe('');
    expect(connectionTypeProblem({ ...form, name: ' ' })).toBe('Give the type a name');
    expect(connectionTypeProblem({ ...form, timeoutSeconds: 4000 })).toBe(
      'The statement time limit is from 1 to 3600 seconds',
    );
    const read = readConnectionType(own('t', 'T', connectionTypeValue(form)))!;
    expect(connectionTypeForm(read)).toMatchObject({ name: 'T', confirmWrites: true });
  });
});
