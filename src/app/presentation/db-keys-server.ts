import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { replyText } from '../domain/db/keyvalue';
import type { KeysRun } from './db-panel/keys-run';

/** The columns of `CLIENT LIST` shown. */
const CLIENT_COLUMNS = ['id', 'addr', 'name', 'user', 'db', 'age', 'idle', 'cmd'];

/**
 * The server of a Redis or Valkey database (DB-35): `INFO` by sections, the clients
 * connected (disconnecting one types its command in the console, which asks for it), and
 * the slow commands.
 */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-keys-server',
  template: `
    @let console = run().console;
    <div class="kv-server-bar">
      <button type="button" class="button small" (click)="console.server()">
        {{ 'Refresh' | transloco }}
      </button>
    </div>
    <section [attr.aria-label]="'Clients' | transloco">
      <h2>{{ 'Clients' | transloco }}</h2>
      <table class="kv-table">
        <thead>
          <tr>
            @for (column of columns; track column) {
              <th scope="col">{{ column }}</th>
            }
            <th scope="col">
              <span class="kv-hidden">{{ 'Actions' | transloco }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          @for (client of console.clients(); track client['id']) {
            <tr>
              @for (column of columns; track column) {
                <td>{{ client[column] }}</td>
              }
              <td>
                <button
                  type="button"
                  class="button small subtle"
                  (click)="disconnect(client['id'])"
                >
                  {{ 'Disconnect' | transloco }}
                </button>
              </td>
            </tr>
          }
        </tbody>
      </table>
    </section>
    <section [attr.aria-label]="'Slow commands' | transloco">
      <h2>{{ 'Slow commands' | transloco }}</h2>
      @for (entry of console.slow(); track $index) {
        <pre class="kv-slow">{{ reply(entry) }}</pre>
      } @empty {
        <p class="muted">{{ 'No slow commands.' | transloco }}</p>
      }
    </section>
    @for (section of console.info(); track section.name) {
      <section [attr.aria-label]="section.name">
        <h2>{{ section.name }}</h2>
        <dl class="kv-info">
          @for (field of section.fields; track field[0]) {
            <dt>{{ field[0] }}</dt>
            <dd>{{ field[1] }}</dd>
          }
        </dl>
      </section>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--nexo-space-4);
      overflow: auto;
    }
    h2 {
      margin: 0 0 var(--nexo-space-2);
      font-size: var(--nexo-font-size-md);
    }
    .kv-table {
      width: 100%;
      border-collapse: collapse;
      th,
      td {
        padding: var(--nexo-space-1) var(--nexo-space-2);
        border-bottom: var(--nexo-border-width) solid var(--nexo-color-border);
        text-align: start;
      }
    }
    .kv-info {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: var(--nexo-space-1) var(--nexo-space-6);
      margin: 0;
      dd {
        margin: 0;
        font-family: var(--nexo-font-mono);
      }
    }
    .kv-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    .kv-slow {
      margin: 0 0 var(--nexo-space-2);
      white-space: pre-wrap;
    }
  `,
})
export class DbKeysServer {
  readonly run = input.required<KeysRun>();
  protected readonly columns = CLIENT_COLUMNS;
  protected readonly reply = replyText;

  /** Ends a client with `CLIENT KILL`, which asks for its name typed as every dangerous one. */
  protected disconnect(id: string) {
    void this.run().console.send(`CLIENT KILL ID ${id}`);
  }
}
