import { signal } from '@angular/core';
import { WorkspaceState } from './workspace-state';

/**
 * Runs a panel action with its own error message, shown in the panel that started it
 * instead of the global banner. The workspace still shows the busy indicator.
 */
export class PanelTask {
  readonly error = signal('');
  constructor(private readonly state: WorkspaceState) {}

  async run(action: () => Promise<unknown>) {
    this.error.set('');
    this.state.busy.set(true);
    try {
      await action();
    } catch (error) {
      this.error.set(this.state.describe(error));
    } finally {
      this.state.busy.set(false);
    }
  }
}
