import { ApiPort, FilePort, PreferencePort } from '../ports';
import { itemAt } from '../../domain/collection-tree';
import { Collection, WorkspaceDocument, asCollection } from '../../domain/models';
import {
  VariableRow,
  applyScriptValues,
  scopeValues,
  toCollectionVariables,
  toPortableRows,
  toVariableRows,
} from '../../domain/variables';
import { ScriptVariables, VariableTargets, createDocument } from './types';

/**
 * Environments, globals and collection settings, with the environment chosen last time and
 * the values scripts set.
 */
export class VariableCases {
  constructor(
    private readonly api: ApiPort,
    private readonly files: FilePort,
    private readonly preferences: PreferencePort,
  ) {}

  /** The environment selected last time in a workspace on this device. */
  rememberedEnvironment(workspace: string): string {
    return this.preferences.read(`environment.${workspace}`) ?? '';
  }
  rememberEnvironment(workspace: string, environment: string) {
    if (workspace) this.preferences.write(`environment.${workspace}`, environment);
  }

  /** Saves an environment, creating it when `existing` is undefined. */
  saveEnvironment(
    workspace: string,
    existing: WorkspaceDocument | undefined,
    name: string,
    rows: readonly VariableRow[],
  ) {
    const values = toPortableRows(rows);
    if (!name.trim()) throw new Error('A name is required');
    return existing
      ? this.api.save({
          ...existing,
          name: name.trim(),
          value: { ...(existing.value as Record<string, unknown>), name: name.trim(), values },
        })
      : createDocument(this.api, this.files.id(), workspace, 'environment', name, {
          name: name.trim(),
          values,
        });
  }

  /** Globals are a single document per workspace, created on first save. */
  saveGlobals(
    workspace: string,
    existing: WorkspaceDocument | undefined,
    rows: readonly VariableRow[],
  ) {
    const values = toPortableRows(rows);
    return existing
      ? this.api.save({ ...existing, value: { ...(existing.value as object), values } })
      : createDocument(this.api, this.files.id(), workspace, 'globals', 'Globals', {
          name: 'Globals',
          values,
        });
  }

  /**
   * Variables, auth and scripts of the collection root or, with a `folder` path, of that
   * folder. A folder without variables stores none.
   */
  async saveCollectionSettings(
    document: WorkspaceDocument,
    settings: { variables: readonly VariableRow[]; auth?: unknown; event?: unknown },
    folder: readonly number[] = [],
  ) {
    const value: Collection = structuredClone(asCollection(document.value));
    const group: Record<string, unknown> | undefined = folder.length
      ? itemAt(value, folder)
      : value;
    if (!group || (folder.length && !Array.isArray(group['item'])))
      throw new Error('Folder not found');
    const variables = toCollectionVariables(settings.variables);
    if (folder.length && !variables.length) delete group['variable'];
    else group['variable'] = variables;
    if (settings.auth === undefined) delete group['auth'];
    else group['auth'] = settings.auth;
    if (settings.event === undefined) delete group['event'];
    else group['event'] = settings.event;
    return this.api.save({ ...document, value });
  }

  /**
   * Writes back the values that scripts set or unset with `nx.environment`, `nx.globals`
   * and `nx.collectionVariables`. Only documents whose values changed are saved.
   */
  async persistScriptVariables(
    variables: ScriptVariables | undefined,
    targets: VariableTargets,
  ): Promise<WorkspaceDocument[]> {
    if (!variables) return [];
    const saved: WorkspaceDocument[] = [];
    if (targets.environment) {
      const current = toVariableRows((targets.environment.value as { values?: unknown })?.values);
      const next = applyScriptValues(current, scopeValues(variables.environment));
      if (next) {
        const name = targets.environment.name;
        saved.push(await this.saveEnvironment(targets.workspace, targets.environment, name, next));
      }
    }
    const currentGlobals = toVariableRows(
      (targets.globals?.value as { values?: unknown } | undefined)?.values,
    );
    const globals = applyScriptValues(currentGlobals, scopeValues(variables.globals));
    if (globals && (targets.globals || globals.some((row) => row.enabled)))
      saved.push(await this.saveGlobals(targets.workspace, targets.globals, globals));
    if (targets.collection) {
      const collection = asCollection(targets.collection.value);
      const current = toVariableRows(collection['variable']);
      const next = applyScriptValues(current, scopeValues(variables.collection));
      if (next)
        saved.push(
          await this.saveCollectionSettings(targets.collection, {
            variables: next,
            auth: collection['auth'],
            event: collection['event'],
          }),
        );
    }
    return saved;
  }
}
