import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { readDbConnection } from '../domain/db/connection';
import { DbTab } from '../domain/db/session';
import { REST_PATHS, curlOf, hitsTable, restBlockAt, restBlocks } from '../domain/db/rest-console';
import { CodeEditor } from './code-editor';
import { DbSection } from './db-panel/section';

/** What a console starts with: requests to try, as Kibana's does. */
const START = `GET _cluster/health

GET _cat/indices?v

POST _search
{
  "query": { "match_all": {} },
  "size": 10
}
`;

/**
 * The console of Query DSL of Elasticsearch and OpenSearch (DB-36): requests as
 * `METHOD path` and their JSON body, the one at the cursor run with Ctrl+Enter; the answer
 * in JSON beside them, or the hits of a search in a table; the history; and the request as
 * cURL, without the connection's secret. Deleting an index asks for its name typed.
 */
@Component({
  imports: [TranslocoPipe, FormField, CodeEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-rest-console',
  templateUrl: './db-rest-console.html',
  styleUrl: './db-rest-console.scss',
  host: { '(keydown)': 'key($event)' },
})
export class DbRestConsole {
  readonly tab = input.required<DbTab>();
  protected readonly section = inject(DbSection);
  protected readonly run = computed(() => this.section.editors.rest(this.tab().id));
  protected readonly text = signal(START);
  private readonly editor = viewChild<CodeEditor>('requests');
  protected readonly asTable = signal(false);
  protected readonly copied = signal('');
  protected readonly confirmation = signal({ name: '' });
  protected readonly typed = form(this.confirmation);
  protected readonly words = computed(() => [...REST_PATHS, ...this.run().indices()]);
  protected readonly pretty = computed(() => {
    const answer = this.run().answer();
    if (!answer) return '';
    return typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body, null, 2);
  });
  protected readonly hits = computed(() => hitsTable(this.run().answer()?.body));

  constructor() {
    effect(() => {
      const run = this.run();
      untracked(() => void run.start());
    });
  }

  /** The request where the cursor is in the editor. */
  private current() {
    const cursor = this.editor()?.editor()?.state.selection.main.head ?? 0;
    return restBlockAt(restBlocks(this.text()), cursor);
  }

  /** Runs the request at the cursor. */
  protected send() {
    const block = this.current();
    if (block) void this.run().run(block);
    else this.run().error.set('db.rest.noRequest');
  }

  /** Ctrl+Enter runs the request at the cursor. */
  protected key(event: KeyboardEvent) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.send();
    }
  }

  /** Runs a request of the cluster's view. */
  protected cluster(path: string) {
    void this.run().run({ method: 'GET', path, body: '', start: 0, end: 0 });
  }

  protected confirm() {
    const waiting = this.run().waiting();
    if (!waiting) return;
    const name = this.confirmation().name;
    this.confirmation.set({ name: '' });
    void this.run().run(waiting.block, name);
  }

  /** Copies the request at the cursor as cURL. */
  protected async curl() {
    const block = this.current();
    if (!block) return;
    const value = readDbConnection(this.section.connection(this.tab().connection)?.value);
    const host = (value.host ?? 'localhost').split(',')[0].trim();
    const base = /^https?:\/\//.test(host)
      ? host
      : `${value.tls?.mode && value.tls.mode !== 'disable' ? 'https' : 'http'}://${host}:${value.port ?? 9200}`;
    const text = curlOf(block, base);
    await navigator.clipboard?.writeText(text).catch(() => undefined);
    this.copied.set(text);
  }
}
