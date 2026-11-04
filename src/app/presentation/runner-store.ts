import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { WORKSPACE } from '../composition/providers';
import { Run, mergeRun } from '../domain/models';
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

  async start(collectionId: string, iterations: number, data: unknown[]) {
    await this.task.run(async () => {
      const collection = this.state.collections().find((d) => d.id === collectionId);
      if (!collection) throw new Error('Choose a collection');
      const started = await this.cases.execute<{ id: string; state: string }>(
        this.state.workspaceId(),
        'run',
        {
          collection: collection.value,
          variables: this.state.variables(),
          globals: toPortableRows(this.state.globalRows()),
          iterations,
          data,
        },
      );
      this.collectionId = collection.id;
      this.run.set({ ...started, results: [], assertions: [], logs: [] });
      this.stopPolling();
      this.schedule(started.id);
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
  /** Polls sequentially, and less often while the window is hidden. */
  private schedule(id: string) {
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    this.timer = setTimeout(() => void this.poll(id), hidden ? 3000 : 400);
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
      if (current.state === 'running') {
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
