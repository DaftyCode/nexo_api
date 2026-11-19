import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { FieldTree, FormField } from '@angular/forms/signals';
import { AUTH_CHOICES, READ_PREFERENCES } from '../domain/mongo';
import { Route } from '../domain/route';
import { CodeEditor } from './code-editor';
import type { PanelModel } from './mongo-panel';
import { RoutePicker } from './route-picker';

/**
 * A tab of the MongoDB connection form: server, authentication, TLS, options or the way to
 * the servers (a SOCKS5 proxy or an SSH tunnel).
 */
@Component({
  imports: [TranslocoPipe, FormField, CodeEditor, RoutePicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-mongo-connection-settings',
  styleUrl: './mongo-panel.scss',
  templateUrl: './mongo-connection-settings.html',
})
export class MongoConnectionSettings {
  readonly tab = input.required<'server' | 'authentication' | 'tls' | 'options' | 'route'>();
  /** The form of the connection panel. */
  readonly fields = input.required<FieldTree<PanelModel>>();
  /** Whether the vault holds the saved password or client key, kept when left blank. */
  readonly passwordStored = input(false);
  readonly keyStored = input(false);
  /** The connection, to read. */
  protected readonly settings = computed(() => this.fields()().value());
  protected readonly authChoices = AUTH_CHOICES;
  protected readonly readPreferences = READ_PREFERENCES;
  protected setRoute(route: Route) {
    this.fields().route().value.set(route);
  }
}
