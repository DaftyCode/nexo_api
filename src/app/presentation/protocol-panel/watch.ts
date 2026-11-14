import { Signal, computed } from '@angular/core';
import type { ProtocolUseCases } from '../../application/protocol-use-cases';
import { WatchPipelineError, watchLabel, watchOptions } from '../../domain/mongo-watch';
import { isMongoConnection } from '../../domain/mongo';
import { resolveVariables } from '../../domain/variables';
import type { ProtocolSettings } from '../protocol-settings';
import type { WorkspaceState } from '../workspace-state';

/**
 * A MongoDB change stream of the protocol panel: the saved connections it can watch, what it
 * watches in one line, and opening it with the variables of the active environment.
 */
export class PanelWatch {
  /** The saved MongoDB connections of the workspace. */
  readonly connections = computed(() => this.state.documents().filter(isMongoConnection));
  /** The connection and what it watches, where the other protocols have their URL. */
  readonly label = computed(() => {
    const m = this.model();
    const connection = this.connections().find((d) => d.id === m.mongoConnection);
    return `${connection?.name ?? ''} · ${watchLabel(m)}`;
  });

  constructor(
    private readonly state: WorkspaceState,
    private readonly protocols: ProtocolUseCases,
    private readonly model: Signal<ProtocolSettings>,
  ) {}

  /** Opens the change stream; read and closed like the panel's other connections. */
  open() {
    const m = this.model();
    const connection = this.connections().find((d) => d.id === m.mongoConnection);
    if (!connection) throw new Error('Choose a saved connection');
    const scopes = this.state.scopes();
    let options;
    try {
      options = watchOptions(m, (text) => resolveVariables(text, scopes));
    } catch (error) {
      if (error instanceof WatchPipelineError) throw new Error(error.key, { cause: error });
      throw error;
    }
    return this.protocols.watch(this.state.workspaceId(), connection, scopes, options);
  }
}
