import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { ExportedFile, TableExportOptions } from '../application/workspace-use-cases/table-export';
import { WorkspaceState, success } from './workspace-state';

/** The separators a CSV can have, with their names. */
const SEPARATORS = [
  { value: ',', label: 'Comma' },
  { value: ';', label: 'Semicolon' },
  { value: '\t', label: 'Tab' },
];

/**
 * «Export table…»: a run or a JSON response as a CSV or Excel file, masked by a set of
 * Settings → Masking when one is chosen. `make` builds the file with the options chosen.
 */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-table-export',
  template: `
    @if (open()) {
      <form class="table-export card" (submit)="$event.preventDefault(); export()">
        <label class="field"
          >{{ 'Format' | transloco
          }}<select [formField]="fields.format">
            <option value="xlsx">{{ 'Excel (.xlsx)' | transloco }}</option>
            <option value="csv">{{ 'CSV' | transloco }}</option>
          </select></label
        >
        @if (model().format === 'csv') {
          <label class="field"
            >{{ 'Separator' | transloco
            }}<select [formField]="fields.separator">
              @for (separator of separators; track separator.value) {
                <option [value]="separator.value">{{ separator.label | transloco }}</option>
              }
            </select></label
          >
        }
        <label class="field"
          >{{ 'Masking' | transloco
          }}<select [formField]="fields.set">
            <option value="">{{ 'None: values as they are' | transloco }}</option>
            @for (set of sets(); track set.id) {
              <option [value]="set.id">{{ set.name }}</option>
            }
          </select></label
        >
        <div class="button-grid">
          <button type="submit" class="button primary">{{ 'Export' | transloco }}</button>
          <button type="button" class="button" (click)="open.set(false)">
            {{ 'Cancel' | transloco }}
          </button>
        </div>
      </form>
    } @else {
      <button type="button" class="button" (click)="open.set(true)">
        {{ 'Export table…' | transloco }}
      </button>
    }
  `,
})
export class TableExport {
  /** Builds the file with the options chosen. */
  readonly make = input.required<(options: TableExportOptions) => Promise<ExportedFile>>();
  protected readonly state = inject(WorkspaceState);
  protected readonly separators = SEPARATORS;
  protected readonly open = signal(false);
  protected readonly model = signal<TableExportOptions>({
    format: 'xlsx',
    separator: ',',
    set: '',
  });
  protected readonly fields = form(this.model);
  protected readonly sets = computed(() => this.state.cases.masking.sets(this.state.documents()));

  protected export() {
    void this.state.announce('The file could not be exported', async () => {
      const file = await this.make()(this.model());
      this.state.cases.files.download(
        file.name,
        new Blob([file.data as BlobPart], { type: file.type }),
        file.type,
      );
      this.open.set(false);
      return file.cut
        ? success('File downloaded', 'toast.exportedCut', { v0: file.name })
        : success('File downloaded', 'toast.downloaded', { v0: file.name });
    });
  }
}
