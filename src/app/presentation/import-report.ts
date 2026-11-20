import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ImportReport } from '../domain/import-report';

/** Items a note lists before saying how many more there are. */
const SHOWN = 10;

/**
 * The report of an import from another API client: what came and, a kind at a time, what
 * did not come as it was (scripts to translate, files to choose again…), naming the
 * requests, folders or environments.
 */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-import-report',
  styles: `
    :host {
      display: grid;
      gap: var(--nexo-space-3);
    }
    ul {
      display: grid;
      gap: var(--nexo-space-2);
      margin: 0;
      padding-left: var(--nexo-space-5);
    }
  `,
  template: `
    <p>
      {{
        'import.summary'
          | transloco
            : {
                v0: report().source,
                v1: report().requests,
                v2: report().folders,
                v3: report().environments,
              }
      }}
    </p>
    @if (notes().length) {
      <p class="muted">{{ 'Some things did not come as they were:' | transloco }}</p>
      <ul class="import-notes">
        @for (note of notes(); track note.code) {
          <li>
            <strong>{{ 'import.note.' + note.code | transloco }}</strong>
            {{ note.shown }}
            @if (note.more) {
              {{ 'import.more' | transloco: { v0: note.more } }}
            }
          </li>
        }
      </ul>
    } @else {
      <p class="muted">{{ 'Everything came as it was.' | transloco }}</p>
    }
  `,
})
export class ImportReportView {
  readonly report = input.required<ImportReport>();
  protected readonly notes = computed(() =>
    this.report().notes.map((note) => ({
      code: note.code,
      shown: note.items.slice(0, SHOWN).join(', '),
      more: Math.max(0, note.items.length - SHOWN),
    })),
  );
}
