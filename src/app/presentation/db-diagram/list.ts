import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { SceneEntity } from '../../domain/db/erd-scene';
import { DiagramDraft } from '../db-panel/diagram-draft';

/**
 * The diagram as a list, for a screen reader and the keyboard: each table with its columns
 * and keys, then each relation with the columns it joins, which it lights up on the canvas.
 */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-diagram-list',
  template: `
    @let scene = draft().scene();
    <h3>{{ 'db.diagram.tables' | transloco: { v0: scene.entities.length } }}</h3>
    <ul class="erd-list-tables">
      @for (entity of scene.entities; track entity.key) {
        <li>
          <div class="erd-list-head">
            <button type="button" class="text-button" (click)="opened.emit(entity)">
              {{ entity.key }}
            </button>
            <button type="button" class="button small subtle" (click)="hide(entity.key)">
              {{ 'Hide' | transloco }}
            </button>
          </div>
          <ul class="erd-list-columns">
            @for (row of entity.rows; track row.name) {
              <li>
                @if (row.primary) {
                  <abbr [attr.title]="'Primary key' | transloco">PK</abbr>
                } @else if (row.foreign) {
                  <abbr [attr.title]="'Foreign key' | transloco">FK</abbr>
                }
                {{ row.text }}
              </li>
            }
          </ul>
        </li>
      }
    </ul>
    <h3>{{ 'db.diagram.relations' | transloco: { v0: scene.lines.length } }}</h3>
    <ul class="erd-list-relations">
      @for (line of scene.lines; track line.key) {
        <li>
          <button
            type="button"
            class="text-button"
            [attr.aria-pressed]="draft().relation() === line.key"
            (click)="draft().relation.set(line.key)"
          >
            {{ line.name }}
          </button>
          <span class="muted"
            >{{ line.from }} ({{ line.fromColumns.join(', ') }}) → {{ line.to }} ({{
              line.toColumns.join(', ')
            }})</span
          >
        </li>
      }
    </ul>
  `,
  styles: `
    :host {
      display: block;
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: var(--nexo-space-6) var(--nexo-space-10);
    }
    h3 {
      margin: var(--nexo-space-6) 0 var(--nexo-space-3);
      font-size: var(--nexo-font-size-lg);
    }
    ul {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .erd-list-tables > li {
      padding: var(--nexo-space-3) 0;
      border-bottom: var(--nexo-border-width) solid var(--nexo-color-border-subtle);
    }
    .erd-list-head {
      display: flex;
      align-items: center;
      gap: var(--nexo-space-4);
    }
    .erd-list-columns {
      padding-left: var(--nexo-space-10);
      font-family: var(--nexo-font-mono);
      font-size: var(--nexo-font-size-sm);
    }
    abbr {
      color: var(--nexo-color-text-muted);
      text-decoration: none;
    }
    .erd-list-relations li {
      display: flex;
      flex-wrap: wrap;
      gap: var(--nexo-space-4);
      padding: var(--nexo-space-2) 0;
    }
  `,
})
export class DbDiagramList {
  readonly draft = input.required<DiagramDraft>();
  readonly opened = output<SceneEntity>();

  protected hide(key: string) {
    this.draft().select(key);
    this.draft().removeSelected();
  }
}
