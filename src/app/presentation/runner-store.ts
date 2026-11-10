import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { WORKSPACE } from '../composition/providers';
import { Run, asCollection, mergeRun } from '../domain/models';
import { toPortableRows } from '../domain/variables';
import { WorkspaceState } from './workspace-state';
import { PanelTask } from './panel-task';

/** Collection runs: start, sequential status polling, cancellation and saving the result. */
@Injectable({ providedIn: 'root' })
export class RunnerStore {
  private readonly state = inject(WorkspaceState);
  private readonly cases = inject(WORKSPACE);
  readonly run = signal<Run | undefined>(undefined);
  readonly task = new PanelTask(this.state);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private collectionId = '';

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stopPolling());
  }

  async start(collectionId: string, iterations: number, data: unknown[], delay = 0) {
    await this.task.run(async () => {
      const collection = this.state.collections().find((d) => d.id === collectionId);
      if (!collection) throw new Error('Choose a collection');
      const started = await this.cases.execute<{ id: string; state: string }>(
        this.state.workspaceId(),
        'run',
        {
          collection: asCollection(collection.value),
          variables: this.state.variables(),
          globals: toPortableRows(this.state.globalRows()),
          iterations,
          data,
          ...(delay > 0 ? { delay } : {}),
        },
      );
      this.collectionId = collection.id;
      this.run.set({ ...started, results: [], assertions: [], logs: [] });
      this.stopPolling();
      this.schedule(started.id);
    });
  }
  /** Name of the collection of the last run started here. */
  collectionName() {
    return this.state.collections().find((d) => d.id === this.collectionId)?.name ?? '';
  }
  /** Pauses between requests: the one being sent finishes, no other starts. */
  async pause() {
    await this.control('run.pause');
  }
  /** Continues with the next request. */
  async resume() {
    await this.control('run.resume');
  }
  private async control(operation: 'run.pause' | 'run.resume') {
    const current = this.run();
    if (!current) return;
    await this.task.run(async () => {
      const answer = await this.cases.execute<Run>(this.state.workspaceId(), operation, {
        id: current.id,
      });
      // Only the state: the results arrive with the next poll.
      this.run.update((run) => (run?.id === current.id ? { ...run, state: answer.state } : run));
    });
  }
  async cancel() {
    const current = this.run();
    if (current)
      await this.task.run(async () => {
        this.run.set(
          await this.cases.execute<Run>(this.state.workspaceId(), 'cancel', { id: current.id }),
        );
      });
  }

  private stopPolling() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  /** Polls sequentially, and less often while the window is hidden or the run paused. */
  private schedule(id: string) {
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const slow = hidden || this.run()?.state === 'paused';
    this.timer = setTimeout(() => void this.poll(id), slow ? 2000 : 400);
  }
  private async poll(id: string) {
    if (this.run()?.id !== id) return;
    try {
      const previous = this.run();
      const update = await this.cases.execute<Run>(this.state.workspaceId(), 'run', {
        action: 'status',
        id,
        after: previous?.counts ?? {},
      });
      if (!previous || this.run()?.id !== id) return;
      const current = mergeRun(previous, update);
      this.run.set(current);
      if (current.state === 'running' || current.state === 'paused') {
        this.schedule(id);
        return;
      }
      this.timer = undefined;
      await this.state.recordRun(current, this.collectionId);
    } catch (error) {
      this.timer = undefined;
      this.task.error.set(this.state.describe(error));
    }
  }
}
