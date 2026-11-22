import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { commandHints, commandSyntax } from '../domain/db/keyvalue/commands';
import type { KeysRun } from './db-panel/keys-run';

/**
 * The console of a Redis or Valkey database (DB-35): a command per line, its answer as
 * redis-cli writes it, the history with the arrow keys, the commands completed with their
 * syntax. The name of a dangerous command is typed in its tab before it runs.
 */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-keys-console',
  template: `
    @let console = run().console;
    <div class="kv-log" role="log" [attr.aria-label]="'Console' | transloco" tabindex="0">
      @for (entry of console.log(); track $index) {
        <p class="kv-line">&gt; {{ entry.line }}</p>
        <pre class="kv-answer" [class.failed]="entry.error">{{ entry.text }}</pre>
      } @empty {
        <p class="muted">{{ 'db.kv.consoleHelp' | transloco }}</p>
      }
    </div>
    <form class="kv-prompt" (submit)="$event.preventDefault(); send()">
      <span aria-hidden="true">&gt;</span>
      <input
        [formField]="fields.line"
        [attr.aria-label]="'Command' | transloco"
        autocomplete="off"
        list="kv-commands"
        placeholder="GET user:1"
        (keydown)="key($event)"
      />
      <datalist id="kv-commands">
        @for (hint of hints(); track hint.name) {
          <option [value]="hint.name">{{ hint.syntax }}</option>
        }
      </datalist>
      <button type="submit" class="button primary small" [disabled]="console.running()">
        {{ 'Run' | transloco }}
      </button>
      <button type="button" class="button small" (click)="console.clear()">
        {{ 'Clear' | transloco }}
      </button>
    </form>
    @if (syntax(); as command) {
      <p class="muted kv-syntax">
        <code>{{ command.name }} {{ command.syntax }}</code>
      </p>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex: 1;
      flex-direction: column;
      gap: var(--nexo-space-2);
      min-height: 0;
    }
    .kv-log {
      flex: 1;
      overflow: auto;
      padding: var(--nexo-space-3);
      border: var(--nexo-border-width) solid var(--nexo-color-border);
      border-radius: var(--nexo-radius-sm);
      font-family: var(--nexo-font-mono);
    }
    .kv-line,
    .kv-answer {
      margin: 0 0 var(--nexo-space-1);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .kv-line {
      color: var(--nexo-color-text-muted);
    }
    .failed {
      color: var(--nexo-color-danger-text);
    }
    .kv-prompt {
      display: flex;
      align-items: center;
      gap: var(--nexo-space-2);
      input {
        flex: 1;
        font-family: var(--nexo-font-mono);
      }
    }
    .kv-syntax {
      margin: 0;
    }
  `,
})
export class DbKeysConsole {
  readonly run = input.required<KeysRun>();
  protected readonly model = signal({ line: '' });
  protected readonly fields = form(this.model);
  protected readonly hints = computed(() => commandHints(this.model().line));
  protected readonly syntax = computed(() => commandSyntax(this.model().line));
  /** Where the arrow keys are in the history: none while a new line is written. */
  private readonly back = signal(0);

  protected send() {
    const line = this.model().line;
    this.model.update((model) => ({ ...model, line: '' }));
    this.back.set(0);
    void this.run().console.send(line);
  }

  /** ↑ and ↓ go through the history. */
  protected key(event: KeyboardEvent) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    const history = this.run().console.history();
    const back = Math.min(
      history.length,
      Math.max(0, this.back() + (event.key === 'ArrowUp' ? 1 : -1)),
    );
    if (back === this.back()) return;
    event.preventDefault();
    this.back.set(back);
    this.model.update((model) => ({ ...model, line: back ? history[history.length - back] : '' }));
  }
}
