import { WorkspaceDocument } from '../../domain/models';
import { ShellAnswer, readHistory, remember } from '../../domain/mongo-shell';
import { VariableScopes } from '../../domain/variables';
import { PreferencePort } from '../ports';
import { MongoPorts } from './payload';

/** The values of the active variables, the narrowest scope winning, to fill the URI. */
function variableValues(scopes: VariableScopes): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rows of [scopes.globals, scopes.collection, scopes.environment])
    for (const row of rows) if (row.enabled && row.key) values[row.key] = row.value;
  return values;
}

/** The MongoDB shell: commands run by the engine, and their history on this device. */
export class MongoShellCases {
  constructor(
    private readonly api: MongoPorts,
    private readonly preferences: PreferencePort,
  ) {}

  /**
   * Runs a command on a saved connection, starting in `database`. A destructive one is
   * refused until `confirm` repeats the name the refusal asks for.
   */
  run(
    workspace: string,
    connection: WorkspaceDocument,
    scopes: VariableScopes,
    database: string,
    command: string,
    confirm?: string,
  ): Promise<ShellAnswer> {
    return this.api.execute<ShellAnswer>('mongo.shell', {
      workspace,
      connection: connection.id,
      database,
      command,
      variables: variableValues(scopes),
      ...(confirm ? { confirm } : {}),
    });
  }

  /** The commands run on a connection, the newest last. */
  history(connection: string): string[] {
    return readHistory(this.preferences.read(`mongo-shell:${connection}`));
  }
  remember(connection: string, command: string): string[] {
    const history = remember(this.history(connection), command);
    this.preferences.write(`mongo-shell:${connection}`, JSON.stringify(history));
    return history;
  }
}
