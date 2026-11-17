import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  WritableSignal,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { RevisionEntry } from '../application/ports';
import { INTEGRATION } from '../composition/providers';
import { WorkspaceDocument } from '../domain/models';
import type { PanelTask } from './panel-task';
import { WorkspaceState, success } from './workspace-state';

/**
 * The history of a document of the workspace: its revisions, read when asked, and one of
 * them restored as a new revision, so nothing is lost.
 */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-document-revisions',
  template: `
    <h2>{{ 'Document history' | transloco }}</h2>
    <label class="field"
      >{{ 'Document' | transloco
      }}<select [formField]="fields.documentId">
        <option value="">{{ 'Choose a resource' | transloco }}</option>
        @for (d of state.documents(); track d.id) {
          <option [value]="d.id">
            {{ 'document.resourceRevision' | transloco: { v0: d.name, v1: d.revision } }}
          </option>
        }
      </select></label
    ><button class="button" (click)="list()">
      {{ 'Load revisions' | transloco }}
    </button>
    @for (revision of revisions(); track revision.revision) {
      <div class="run-result">
        <span>{{ 'document.revision' | transloco: { v0: revision.revision } }}</span><button
          class="button"
          (click)="restore(revision.value)"
        >
          {{ 'Restore as new revision' | transloco }}
        </button>
      </div>
    }
  `,
})
export class DocumentRevisions {
  /** The panel's task, to say what failed where the panel says it. */
  readonly task = input.required<PanelTask>();
  /** The panel's message line. */
  readonly output = input.required<WritableSignal<string>>();
  protected readonly state = inject(WorkspaceState);
  private readonly integration = inject(INTEGRATION);
  protected readonly model = signal({ documentId: '' });
  protected readonly fields = form(this.model);
  protected readonly revisions = signal<RevisionEntry[]>([]);

  protected list() {
    void this.task().run(async () => {
      this.revisions.set(await this.integration.revisions(this.model().documentId));
    });
  }
  protected restore(value: WorkspaceDocument) {
    void this.task().announce('The revision could not be restored', async () => {
      const current = this.state.documents().find((d) => d.id === value.id);
      await this.integration.restoreRevision(value, current);
      await this.state.refresh();
      this.output().set('Revision restored as a new revision.');
      return success('Revision restored', 'toast.revisionRestored', { v0: value.name });
    });
  }
}
