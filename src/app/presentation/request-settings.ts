import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { FieldTree, FormField } from '@angular/forms/signals';
import { RequestDraft } from '../domain/models';
import { CodeEditor } from './code-editor';

/** The settings of a request: timeout, redirects, TLS, protocol, proxy and client TLS. */
@Component({
  imports: [TranslocoPipe, FormField, CodeEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-request-settings',
  styles: ':host { display: contents; }',
  templateUrl: './request-settings.html',
})
export class RequestSettings {
  /** The form of the request editor. */
  readonly fields = input.required<FieldTree<RequestDraft>>();
}
