import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { CodeEditor } from './code-editor';
import type { Workspace } from './workspace';

/** The dialogs of the workspace: import, new collection, workspace or folder, rename, shortcuts. */
@Component({
  imports: [TranslocoPipe, FormField, CodeEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-workspace-dialogs',
  styleUrl: './workspace.scss',
  styles: ':host { display: contents; }',
  templateUrl: './workspace-dialogs.html',
})
export class WorkspaceDialogs {
  readonly workspace = input.required<Workspace>();
}
