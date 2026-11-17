import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { KillMode } from '../../domain/db/admin';

/** The session a dialog asks about: its id on the server, its user and its statement. */
export interface KillTarget {
  id: string;
  user?: string;
  sql?: string;
}

/**
 * Asks before cancelling the statement of a session of the server or ending it, showing its
 * user and its statement; on a production connection, the id of the session is typed.
 */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-kill-dialog',
  template: `
    <div class="modal-backdrop">
      <section
        class="modal db-kill"
        role="dialog"
        aria-modal="true"
        aria-labelledby="db-kill-title"
        (keydown.escape)="closed.emit()"
      >
        <div class="modal-heading">
          <h2 id="db-kill-title">{{ action() | transloco }}</h2>
          <button
            type="button"
            class="icon-button"
            [attr.aria-label]="'Close dialog' | transloco"
            (click)="closed.emit()"
          >
            ×
          </button>
        </div>
        <p>
          {{
            (mode() === 'cancel' ? 'db.kill.cancelText' : 'db.kill.terminateText')
              | transloco: { v0: target().id, v1: target().user || '—' }
          }}
        </p>
        @if (target().sql; as sql) {
          <pre class="db-kill-sql" [attr.aria-label]="'Statement' | transloco">{{ sql }}</pre>
        }
        @if (production()) {
          <label class="db-kill-type">
            {{ 'db.kill.type' | transloco: { v0: target().id } }}
            <input autocomplete="off" [value]="typed()" (input)="type($event)" />
          </label>
        }
        <div class="modal-actions">
          <button type="button" class="button" (click)="closed.emit()">
            {{ 'No' | transloco }}
          </button>
          <button
            type="button"
            class="button primary danger"
            [disabled]="!ready()"
            (click)="confirmed.emit(typed().trim())"
          >
            {{ action() | transloco }}
          </button>
        </div>
      </section>
    </div>
  `,
  styles: `
    .db-kill-sql {
      max-height: 30vh;
      overflow: auto;
      padding: var(--nexo-space-4);
      border-radius: var(--nexo-radius-md);
      background: var(--nexo-color-code-bg);
      color: var(--nexo-color-code-text);
      font: var(--nexo-font-size-sm) / var(--nexo-line-height-normal) var(--nexo-font-mono);
      white-space: pre-wrap;
    }
    .db-kill-type {
      display: grid;
      gap: var(--nexo-space-2);
    }
  `,
})
export class DbKillDialog {
  readonly target = input.required<KillTarget>();
  readonly mode = input.required<KillMode>();
  /** A production connection: the id of the session is typed to confirm. */
  readonly production = input(false);
  /** What was typed, when it was asked for. */
  readonly confirmed = output<string>();
  readonly closed = output<void>();
  protected readonly typed = signal('');
  protected readonly action = computed(() =>
    this.mode() === 'cancel' ? 'Cancel the query' : 'End the session',
  );
  protected readonly ready = computed(
    () => !this.production() || this.typed().trim() === this.target().id,
  );

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    afterNextRender(() =>
      host.querySelector<HTMLElement>('input, .modal-actions .button')?.focus(),
    );
  }

  protected type(event: Event) {
    this.typed.set((event.target as HTMLInputElement).value);
  }
}
