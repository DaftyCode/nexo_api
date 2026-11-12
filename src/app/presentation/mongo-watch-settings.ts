import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { FieldTree, FormField } from '@angular/forms/signals';
import { WorkspaceDocument } from '../domain/models';
import { CodeEditor } from './code-editor';
import { ProtocolSettings } from './protocol-settings';

/**
 * A MongoDB change stream: the saved connection, what is watched, the pipeline that filters
 * the changes, the documents each change carries and where it starts.
 */
@Component({
  imports: [TranslocoPipe, FormField, CodeEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-mongo-watch-settings',
  styles: ':host { display: contents; }',
  templateUrl: './mongo-watch-settings.html',
})
export class MongoWatchSettings {
  /** The form of the protocol panel. */
  readonly fields = input.required<FieldTree<ProtocolSettings>>();
  /** The saved MongoDB connections of the workspace. */
  readonly connections = input.required<readonly WorkspaceDocument[]>();
}
