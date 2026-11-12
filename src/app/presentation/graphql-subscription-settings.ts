import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { FieldTree, FormField } from '@angular/forms/signals';
import { CodeEditor } from './code-editor';
import { GraphqlQueryEditor } from './graphql-query-editor';
import { ProtocolSettings } from './protocol-settings';
import { WorkspaceState } from './workspace-state';

/** A GraphQL subscription: its protocol, operation, variables and connection parameters. */
@Component({
  imports: [TranslocoPipe, FormField, CodeEditor, GraphqlQueryEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-graphql-subscription-settings',
  styles: ':host { display: contents; }',
  templateUrl: './graphql-subscription-settings.html',
})
export class GraphqlSubscriptionSettings {
  /** The form of the protocol panel. */
  readonly fields = input.required<FieldTree<ProtocolSettings>>();
  /** The settings, to read. */
  protected readonly settings = computed(() => this.fields()().value());
  /** Loads the schema of the endpoint by introspection. */
  readonly schemaRequested = output<void>();
  protected readonly state = inject(WorkspaceState);
  /** The schema loaded for the endpoint, if any. */
  protected readonly schema = computed(() => this.state.schemaFor(this.settings().url));
}
