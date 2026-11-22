import type { WorkspaceDocument } from '../../domain/models';
import { readTaskRuns, type TaskRun } from '../../domain/db/tasks';
import { ApiFailure } from '../ports';
import type { DatabasePorts } from './connections';
import type { StatementPorts } from './statements';

/** When a task runs next, and whether it runs now. */
export interface TaskState {
  id: string;
  running: boolean;
  next: number | null;
}

/**
 * Saved database tasks (DB-31): saved as documents with their revisions, run now by the
 * application (`db.task.run`, which answers the run its history keeps), their last runs from
 * that history (`<task>~history`), and their next runs from the scheduler of the monitors.
 */
export class DatabaseTaskCases {
  constructor(
    private readonly api: Pick<
      DatabasePorts & StatementPorts,
      'execute' | 'save' | 'remove' | 'document'
    >,
  ) {}

  save(
    workspace: string,
    id: string,
    name: string,
    value: Record<string, unknown>,
    existing?: WorkspaceDocument,
  ): Promise<WorkspaceDocument> {
    return this.api.save({
      id,
      workspace_id: workspace,
      kind: 'db-task',
      name: name.trim(),
      revision: existing?.revision ?? 0,
      updated_at: existing?.updated_at ?? 0,
      value,
    });
  }

  /** Deletes a task; the backend deletes its history with it. */
  remove(document: WorkspaceDocument): Promise<void> {
    return this.api.remove(document);
  }

  run(workspace: string, id: string): Promise<TaskRun> {
    return this.api.execute<TaskRun>('db.task.run', { workspace, id });
  }

  /** The last runs of a task, newest first; none before its first run. */
  async history(task: string): Promise<TaskRun[]> {
    try {
      return readTaskRuns((await this.api.document(`${task}~history`)).value);
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 404) return [];
      throw error;
    }
  }

  async states(workspace: string): Promise<TaskState[]> {
    const answer = await this.api.execute<{ tasks?: TaskState[] }>('monitor.status', {
      workspace,
      after: 0,
    });
    return answer.tasks ?? [];
  }
}
