import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import type { SqlRunner } from './db-panel/sql-runner';
import { DbSqlParams } from './db-sql-params';
import type { DialogRequest } from './mongo-dialog';
import { MongoDialog } from './mongo-dialog';

/**
 * What a runner asks while it runs, for a SQL tab and a console alike: to confirm a statement
 * that needs it, what to do after one fails, and the values of a statement's parameters.
 */
@Component({
  imports: [TranslocoPipe, FormField, MongoDialog, DbSqlParams],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-runner-dialogs',
  template: `
    @if (confirmRequest(); as request) {
      <app-mongo-dialog
        [request]="request"
        (confirmed)="confirmAnswer(true)"
        (cancelled)="confirmAnswer(false)"
      />
    }
    @if (runner().dialog()?.kind === 'failure') {
      <div class="db-sql-backdrop">
        <section
          class="feature-card db-sql-failure"
          role="dialog"
          aria-modal="true"
          aria-labelledby="db-sql-failure-title"
          (keydown.escape)="failureAnswer('stop')"
        >
          <h2 id="db-sql-failure-title">{{ 'A statement failed' | transloco }}</h2>
          <p>{{ 'db.failure.message' | transloco }}</p>
          <label class="check-field"
            ><input type="checkbox" [formField]="failureFields.remember" />{{
              'Remember my choice' | transloco
            }}</label
          >
          <div class="row db-sql-failure-actions">
            <button type="button" class="button primary" (click)="failureAnswer('continue')">
              {{ 'Continue' | transloco }}
            </button>
            <button type="button" class="button" (click)="failureAnswer('ignore')">
              {{ 'Ignore the next failures' | transloco }}
            </button>
            <button type="button" class="button" (click)="failureAnswer('stop')">
              {{ 'Stop' | transloco }}
            </button>
          </div>
        </section>
      </div>
    }
    @if (runner().client.question(); as question) {
      <app-db-sql-params [question]="question" />
    }
  `,
  styles: `
    .db-sql-backdrop {
      position: fixed;
      inset: 0;
      z-index: var(--nexo-z-dropdown);
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--nexo-color-backdrop);
    }
    .db-sql-failure {
      max-width: calc(var(--nexo-size-unit) * 130);
    }
    .db-sql-failure-actions {
      gap: var(--nexo-space-4);
      justify-content: flex-end;
    }
  `,
})
export class DbRunnerDialogs {
  readonly runner = input.required<SqlRunner>();
  protected readonly failure = signal({ remember: false });
  protected readonly failureFields = form(this.failure);

  protected readonly confirmRequest = computed((): DialogRequest | undefined => {
    const dialog = this.runner().dialog();
    if (dialog?.kind !== 'confirm') return undefined;
    const { confirmation } = dialog;
    return {
      title: 'Confirm the statement',
      message: { key: confirmation.message, params: confirmation.params },
      ...(confirmation.names ? { confirmName: confirmation.names } : {}),
      confirm: 'Run',
      danger: true,
    };
  });
  protected confirmAnswer(ok: boolean) {
    const dialog = this.runner().dialog();
    if (dialog?.kind === 'confirm') dialog.answer(ok);
  }
  protected failureAnswer(choice: 'continue' | 'stop' | 'ignore') {
    const dialog = this.runner().dialog();
    if (dialog?.kind === 'failure') dialog.answer(choice, this.failure().remember);
    this.failure.set({ remember: false });
  }
}
