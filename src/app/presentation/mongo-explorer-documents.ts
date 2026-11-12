import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { CodeEditor } from './code-editor';
import type { MongoExplorer } from './mongo-explorer';
import { MongoResults } from './mongo-results';

/** The documents of a collection: the query bar, its pages of results and their writes. */
@Component({
  imports: [TranslocoPipe, FormField, CodeEditor, MongoResults],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-mongo-explorer-documents',
  styleUrl: './mongo-explorer.scss',
  styles: ':host { display: contents; }',
  templateUrl: './mongo-explorer-documents.html',
})
export class MongoExplorerDocuments {
  readonly explorer = input.required<MongoExplorer>();
}
