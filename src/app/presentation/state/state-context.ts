import { signal } from '@angular/core';
import { failureCode } from '../../application/ports';
import { WorkspaceUseCases } from '../../application/workspace-use-cases';
import { TabsStore } from '../tabs-store';

const translatedCodes = new Set([
  'unauthorized',
  'not_found',
  'conflict',
  'internal',
  'unreachable',
]);

/** Feedback shared by the workspace: global error, notice and busy indicator. */
export class StatusStore {
  readonly error = signal('');
  readonly notice = signal('');
  readonly busy = signal(false);

  /** Runs an action, showing its failure in the global banner. */
  async guard(action: () => Promise<unknown>) {
    this.error.set('');
    this.busy.set(true);
    try {
      await action();
    } catch (error) {
      this.error.set(this.describe(error));
    } finally {
      this.busy.set(false);
    }
  }
  /** Errors with a stable backend code use a translated message; others keep their text. */
  describe(error: unknown) {
    const code = failureCode(error);
    if (code && translatedCodes.has(code)) return `error.${code}`;
    return error instanceof Error ? error.message : String(error);
  }
}

/** What every workspace store shares. */
export interface StateContext {
  readonly cases: WorkspaceUseCases;
  readonly status: StatusStore;
  readonly tabs: TabsStore;
  /** Current workspace. */
  readonly workspaceId: ReturnType<typeof signal<string>>;
  /** Visible workspace section. */
  readonly section: ReturnType<typeof signal<string>>;
  /** Asks the user to confirm a destructive action. */
  confirm(message: string): boolean;
}
