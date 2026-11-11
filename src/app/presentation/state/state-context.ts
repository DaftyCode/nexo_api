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

/** How long a toast stays before it closes by itself. */
export const TOAST_DURATION = 20_000;
/** A short message over the workspace: what went well or wrong. */
export interface Toast {
  kind: 'success' | 'error' | 'info';
  /** Translation keys. */
  title: string;
  message?: string;
  params?: Record<string, string>;
  /** Text as it came, such as a server's error. */
  detail?: string;
}
/** A toast saying that something was stored, deleted or downloaded. */
export function success(title: string, message?: string, params?: Record<string, string>): Toast {
  return { kind: 'success', title, ...(message ? { message } : {}), ...(params ? { params } : {}) };
}
/** A toast naming what was stored, deleted or downloaded. */
export function named(title: string, name: string): Toast {
  return success(title, 'toast.named', { v0: name });
}

/** Feedback shared by the workspace: global error, notice, toast and busy indicator. */
export class StatusStore {
  readonly error = signal('');
  readonly notice = signal('');
  readonly busy = signal(false);
  /** A message that closes by itself after 20 seconds, or with its button. */
  readonly toast = signal<Toast | undefined>(undefined);
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  showToast(toast: Toast) {
    clearTimeout(this.toastTimer);
    this.toast.set(toast);
    this.toastTimer = setTimeout(() => this.toast.set(undefined), TOAST_DURATION);
  }
  closeToast() {
    clearTimeout(this.toastTimer);
    this.toast.set(undefined);
  }
  /** Says something in a toast, and keeps its title in the status bar. */
  tell(toast: Toast) {
    this.notice.set(toast.title);
    this.showToast(toast);
  }
  /**
   * Runs an action that stores, deletes or downloads something and says in a toast how it
   * went: the toast the action returns (what it did, or why it did nothing), or `failure` with
   * the reason. A failure is said in the toast, not in the banner too. The status bar keeps
   * the title. Returns whether the action did not fail.
   */
  async announce(failure: string, action: () => Promise<Toast | undefined>) {
    this.error.set('');
    this.busy.set(true);
    try {
      const outcome = await action();
      if (outcome) this.tell(outcome);
      return true;
    } catch (error) {
      this.tell({ kind: 'error', title: failure, detail: this.describe(error) });
      return false;
    } finally {
      this.busy.set(false);
    }
  }

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
