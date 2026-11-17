import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { DEFAULT_FORMATS } from '../domain/db/grid/cells';
import { plainText } from '../domain/db/grid/text';
import { DbSection } from './db-panel/section';
import type { DbTab } from './db-panel/tabs-store';
import { DbRunnerDialogs } from './db-runner-dialogs';

/** A line of the console: what was typed, or what came back. */
interface ConsoleLine {
  id: number;
  kind: 'input' | 'rows' | 'info' | 'warning' | 'error';
  text: string;
  params?: Record<string, string>;
}

/** The lines the console keeps. */
const KEPT = 400;
/** The commands typed that the arrows go back through. */
const REMEMBERED = 100;

/**
 * The SQL console of a connection, as DBeaver's: a line to type statements in, each run on
 * the console's own session when Enter is pressed (Shift+Enter for a new line), its rows
 * shown as text and its messages below; the arrows go back through what was typed.
 */
@Component({
  imports: [TranslocoPipe, DbRunnerDialogs],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-console',
  template: `
    <section class="db-console" [attr.aria-label]="'SQL console' | transloco">
      <div #output class="db-console-output" role="log" aria-live="polite">
        @for (line of lines(); track line.id) {
          @if (line.kind === 'input') {
            <pre class="db-console-input-line">&gt; {{ line.text }}</pre>
          } @else if (line.kind === 'rows') {
            <pre class="db-console-rows">{{ line.text }}</pre>
          } @else {
            <p [class]="'db-console-message db-console-' + line.kind">
              {{ line.text | transloco: line.params }}
            </p>
          }
        } @empty {
          <p class="db-console-hint">{{ 'db.console.hint' | transloco }}</p>
        }
      </div>
      <div class="db-console-prompt">
        <span aria-hidden="true">&gt;</span>
        <textarea
          #prompt
          class="db-console-text grow"
          rows="1"
          autocomplete="off"
          spellcheck="false"
          [attr.aria-label]="'Statement to run' | transloco"
          [value]="text()"
          [disabled]="busy()"
          (input)="text.set($any($event.target).value)"
          (keydown)="key($event)"
        ></textarea>
        <button type="button" class="button small subtle" (click)="clear()">
          {{ 'Clear' | transloco }}
        </button>
      </div>
    </section>
    <app-db-runner-dialogs [runner]="runner()" />
  `,
  styleUrl: './db-console.scss',
})
export class DbConsole {
  readonly tab = input.required<DbTab>();
  private readonly section = inject(DbSection);
  protected readonly runner = computed(() => this.section.runner(this.tab().id));
  protected readonly lines = signal<readonly ConsoleLine[]>([]);
  protected readonly text = signal('');
  protected readonly busy = signal(false);
  private readonly typed: string[] = [];
  private back = -1;
  private next = 0;
  private readonly output = viewChild<ElementRef<HTMLElement>>('output');
  private readonly prompt = viewChild<ElementRef<HTMLTextAreaElement>>('prompt');

  constructor() {
    effect(() => {
      this.lines();
      const element = this.output()?.nativeElement;
      if (element) queueMicrotask(() => (element.scrollTop = element.scrollHeight));
    });
  }

  protected key(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void this.run();
    } else if (event.key === 'ArrowUp' && !this.text().includes('\n')) {
      event.preventDefault();
      this.recall(1);
    } else if (event.key === 'ArrowDown' && !this.text().includes('\n')) {
      event.preventDefault();
      this.recall(-1);
    }
  }

  private recall(step: number) {
    if (!this.typed.length) return;
    this.back = Math.min(Math.max(this.back + step, -1), this.typed.length - 1);
    this.text.set(this.back < 0 ? '' : this.typed[this.typed.length - 1 - this.back]);
  }

  protected clear() {
    this.lines.set([]);
    this.prompt()?.nativeElement.focus();
  }

  private add(...lines: Omit<ConsoleLine, 'id'>[]) {
    this.lines.update((all) =>
      [...all, ...lines.map((line) => ({ ...line, id: ++this.next }))].slice(-KEPT),
    );
  }

  /** Runs what was typed, then turns its results and messages into lines. */
  async run() {
    const sql = this.text().trim();
    if (!sql || this.busy()) return;
    if (this.typed.at(-1) !== sql) this.typed.push(sql);
    this.typed.splice(0, Math.max(0, this.typed.length - REMEMBERED));
    this.back = -1;
    this.text.set('');
    this.add({ kind: 'input', text: sql });
    const runner = this.runner();
    runner.results.clearMessages();
    this.busy.set(true);
    try {
      await runner.runScript(sql);
    } finally {
      this.busy.set(false);
    }
    const said = [
      ...runner.results.tabs().map((tab) => ({
        at: tab.startedAt,
        line: {
          kind: 'rows' as const,
          text: plainText(
            tab.columns,
            tab.rows,
            tab.columns.map((_, at) => at),
            tab.rows.map((_, at) => at),
            DEFAULT_FORMATS,
          ),
        },
      })),
      ...runner.results.messages().map((message) => ({
        at: message.at,
        line: {
          kind: message.kind,
          text: message.text,
          ...(message.params ? { params: message.params } : {}),
        },
      })),
    ].sort((a, b) => a.at - b.at);
    this.add(...said.map((each) => each.line));
    // What was read is kept as text: its cursors are closed and its tabs let go.
    runner.results.close(() => true);
    runner.results.clearMessages();
    queueMicrotask(() => this.prompt()?.nativeElement.focus());
  }
}
