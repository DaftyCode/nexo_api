import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { FieldTree, FormField } from '@angular/forms/signals';
import { WorkspaceDocument } from '../domain/models';
import { ProtocolSettings } from './protocol-settings';

/**
 * A Redis subscription (DB-35): the saved connection, the channels (`SUBSCRIBE`) and the
 * patterns (`PSUBSCRIBE`) it follows. Messages are published from the console of the
 * connection with `PUBLISH`.
 */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-redis-subscribe-settings',
  styles: ':host { display: contents; }',
  template: `
    <label class="field">
      <span>{{ 'Connection' | transloco }}</span>
      <select [formField]="fields().redisConnection">
        <option value="">{{ 'Choose a saved connection' | transloco }}</option>
        @for (connection of connections(); track connection.id) {
          <option [value]="connection.id">{{ connection.name }}</option>
        }
      </select>
    </label>
    <label class="field">
      <span>{{ 'Channels' | transloco }}</span>
      <input [formField]="fields().channels" placeholder="news, orders" />
    </label>
    <label class="field">
      <span>{{ 'Patterns' | transloco }}</span>
      <input [formField]="fields().patterns" placeholder="news.*" />
    </label>
    <p class="muted">{{ 'db.kv.subscribeHelp' | transloco }}</p>
  `,
})
export class RedisSubscribeSettings {
  /** The form of the protocol panel. */
  readonly fields = input.required<FieldTree<ProtocolSettings>>();
  /** The saved Redis connections of the workspace. */
  readonly connections = input.required<readonly WorkspaceDocument[]>();
}
