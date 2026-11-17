import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { DbSection } from './db-panel/section';

/** A statement of the script, as the outline lists it. */
interface OutlineEntry {
  start: number;
  line: number;
  text: string;
}

/** How long the outline waits after typing stops before reading the script again. */
const SETTLE_MS = 400;
/** The characters of a statement the outline shows. */
const SHOWN = 80;

/**
 * The outline of a script, as DBeaver's: its statements, split as the driver splits them,
 * each with its line, and a click goes to it in the editor.
 */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-sql-outline',
  template: `
    <aside class="db-side" [attr.aria-label]="'Outline' | transloco">
      <header class="row db-side-head">
        <h3>{{ 'Outline' | transloco }}</h3>
        <button
          type="button"
          class="icon-button"
          [attr.aria-label]="'Close' | transloco"
          (click)="closed.emit()"
        >
          ×
        </button>
      </header>
      <ol class="db-outline">
        @for (entry of entries(); track entry.start) {
          <li>
            <button type="button" class="db-outline-entry" (click)="goTo.emit(entry.start)">
              <span class="db-outline-line">{{ entry.line }}</span>
              <code>{{ entry.text }}</code>
            </button>
          </li>
        } @empty {
          <li class="muted">{{ 'The script has no statements' | transloco }}</li>
        }
      </ol>
    </aside>
  `,
  styleUrl: './db-sql-side.scss',
})
export class DbSqlOutline {
  readonly text = input.required<string>();
  readonly driver = input('');
  readonly goTo = output<number>();
  readonly closed = output<void>();
  private readonly section = inject(DbSection);
  protected readonly entries = signal<readonly OutlineEntry[]>([]);

  constructor() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    inject(DestroyRef).onDestroy(() => clearTimeout(timer));
    effect(() => {
      const text = this.text();
      const driver = this.driver();
      clearTimeout(timer);
      timer = setTimeout(() => void this.read(text, driver), SETTLE_MS);
    });
  }

  private async read(text: string, driver: string) {
    try {
      const cases = await this.section.cases();
      const split = await cases.statements.split(this.section.state.workspaceId(), text, driver);
      this.entries.set(
        split.statements.map((statement) => {
          const flat = statement.text.replace(/\s+/g, ' ').trim();
          return {
            start: statement.start,
            line: statement.line,
            text: flat.length > SHOWN ? `${flat.slice(0, SHOWN)}…` : flat,
          };
        }),
      );
    } catch {
      this.entries.set([]);
    }
  }
}
