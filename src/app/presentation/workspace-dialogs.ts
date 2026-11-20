import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { CodeEditor } from './code-editor';
import { ImportReportView } from './import-report';
import type { Workspace } from './workspace';

/**
 * The dialogs of the workspace: import and its report, new collection, workspace or folder,
 * rename, shortcuts.
 */
@Component({
  imports: [TranslocoPipe, FormField, CodeEditor, ImportReportView],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-workspace-dialogs',
  styleUrl: './workspace.scss',
  styles: ':host { display: contents; }',
  templateUrl: './workspace-dialogs.html',
})
export class WorkspaceDialogs {
  readonly workspace = input.required<Workspace>();
  /** Dialogs that only show something: they have a Close button and no action. */
  protected readonly closes = computed(() =>
    ['shortcuts', 'imported'].includes(this.workspace().dialogs()),
  );
}
