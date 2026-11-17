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
import { DiagramTable } from '../../domain/db/erd-document';
import { connectionTables } from '../db-panel/diagram-load';
import { DbSection } from '../db-panel/section';
import { PanelTask } from '../panel-task';

const keyOf = (table: DiagramTable) => table.path.join('\n');

/**
 * The tables of a connection, to put some on a saved diagram: with the keyboard, as dragging
 * them from the navigator does with the mouse. Those already on it are not offered.
 */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-diagram-picker',
  template: `
    <div class="modal-backdrop">
      <section
        class="modal erd-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="erd-picker-title"
        (keydown.escape)="closed.emit()"
      >
        <div class="modal-heading">
          <h2 id="erd-picker-title">{{ 'Add tables' | transloco }}</h2>
          <button
            type="button"
            class="icon-button"
            [attr.aria-label]="'Close dialog' | transloco"
            (click)="closed.emit()"
          >
            ×
          </button>
        </div>
        @if (task.error()) {
          <p class="erd-picker-error" role="alert">{{ task.error() | transloco }}</p>
        }
        <input
          #filter
          type="search"
          class="erd-picker-filter"
          [attr.aria-label]="'Filter tables' | transloco"
          [placeholder]="'Filter tables' | transloco"
          (input)="text.set(filter.value)"
        />
        @if (!tables()) {
          <div class="spinner" role="status" [attr.aria-label]="'Loading' | transloco"></div>
        } @else {
          <ul class="erd-picker-list" [attr.aria-label]="'Tables' | transloco">
            @for (table of shown(); track key(table)) {
              <li>
                <label>
                  <input
                    type="checkbox"
                    [checked]="chosen().has(key(table))"
                    (change)="toggle(table)"
                  />
                  {{ table.schema ? table.schema + '.' : '' }}{{ table.name }}
                </label>
              </li>
            } @empty {
              <li class="muted">{{ 'No tables' | transloco }}</li>
            }
          </ul>
        }
        <div class="modal-actions">
          <button type="button" class="button" (click)="closed.emit()">
            {{ 'Cancel' | transloco }}
          </button>
          <button type="button" class="button primary" [disabled]="!chosen().size" (click)="add()">
            {{ 'Add' | transloco }}
          </button>
        </div>
      </section>
    </div>
  `,
  styles: `
    .erd-picker-filter {
      width: 100%;
    }
    .erd-picker-list {
      max-height: 50vh;
      overflow: auto;
      margin: var(--nexo-space-5) 0 0;
      padding: 0;
      list-style: none;
    }
    .erd-picker-list li {
      padding: var(--nexo-space-2) 0;
    }
    .erd-picker-error {
      color: var(--nexo-color-danger-text);
    }
  `,
})
export class DbDiagramPicker {
  readonly connection = input.required<string>();
  /** The tables already on the diagram, by path. */
  readonly present = input<readonly string[][]>([]);
  readonly added = output<DiagramTable[]>();
  readonly closed = output<void>();
  private readonly section = inject(DbSection);
  protected readonly task = new PanelTask(this.section.state);
  protected readonly tables = signal<DiagramTable[] | undefined>(undefined);
  protected readonly text = signal('');
  protected readonly chosen = signal<ReadonlySet<string>>(new Set());
  protected readonly key = keyOf;
  protected readonly shown = computed(() => {
    const present = new Set(this.present().map((path) => path.join('\n')));
    const text = this.text().trim().toLowerCase();
    return (this.tables() ?? []).filter(
      (table) =>
        !present.has(keyOf(table)) &&
        (!text || `${table.schema ?? ''}.${table.name}`.toLowerCase().includes(text)),
    );
  });

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    afterNextRender(() => {
      host.querySelector<HTMLElement>('.erd-picker-filter')?.focus();
      void this.task.run(async () =>
        this.tables.set(await connectionTables(this.section, this.connection())),
      );
    });
  }

  protected toggle(table: DiagramTable) {
    const chosen = new Set(this.chosen());
    if (!chosen.delete(keyOf(table))) chosen.add(keyOf(table));
    this.chosen.set(chosen);
  }
  protected add() {
    const chosen = this.chosen();
    this.added.emit((this.tables() ?? []).filter((table) => chosen.has(keyOf(table))));
  }
}
