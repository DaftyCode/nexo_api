import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { CodeEditor } from './code-editor';
import { ImportReportView } from './import-report';
import { SharedDialog } from './shared-dialog';
import { SharedState } from './shared-state';
import type { Workspace } from './workspace';

/**
 * The dialogs of the workspace: import and its report, new collection, workspace or folder,
 * rename, shortcuts, and the one of the collections shared by the team.
 */
@Component({
  imports: [TranslocoPipe, FormField, CodeEditor, ImportReportView, SharedDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-workspace-dialogs',
  styleUrl: './workspace.scss',
  styles: ':host { display: contents; }',
  templateUrl: './workspace-dialogs.html',
})
export class WorkspaceDialogs {
  readonly workspace = input.required<Workspace>();
  protected readonly shared = inject(SharedState);
  /** Dialogs that only show something: they have a Close button and no action. */
  protected readonly closes = computed(() =>
    ['shortcuts', 'imported'].includes(this.workspace().dialogs()),
  );
}
