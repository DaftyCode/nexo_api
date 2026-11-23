import type { AiContext } from '../application/payloads';
import { AiUse, mongoQueryOf } from '../domain/ai';
import { pipelineText } from '../domain/mongo-aggregation';
import { toItem } from '../domain/models';
import type { DbSection } from './db-panel/section';
import type { MongoExplorer } from './mongo-explorer';
import { WorkspaceState, success } from './workspace-state';

/**
 * The place the chat is in (IA-01): what its tools may read there, and what a block of code
 * of an answer becomes when the person presses its button. Nothing runs or changes without
 * that button.
 */
export interface AiHost {
  context(): AiContext | undefined;
  use(use: AiUse): void;
}

type Translate = (key: string, params?: Record<string, string>) => string;

/** Beside a request: the open request and its last response; a script joins its tests. */
export function requestHost(state: WorkspaceState): AiHost {
  return {
    context() {
      const tab = state.active();
      if (!tab) return undefined;
      const response = state.response();
      return {
        place: 'request',
        request: toItem(tab.request) as unknown as Record<string, unknown>,
        ...(response ? { response: response as unknown as Record<string, unknown> } : {}),
        ...(tab.documentId ? { collectionId: tab.documentId } : {}),
        ...(response?.error ? { error: response.error } : {}),
      };
    },
    use({ code }) {
      const tab = state.active();
      if (!tab) return;
      const kept = tab.request.tests.trimEnd();
      state.tabsStore.edit({ ...tab.request, tests: `${kept ? `${kept}\n\n` : ''}${code}\n` });
      state.tell(success('Added to the tests'));
    },
  };
}

/** Beside a SQL script: the script, its connection and its last error; a query opens in a tab. */
export function sqlHost(section: DbSection, translate: Translate): AiHost {
  return {
    context() {
      const tab = section.tabs.active();
      if (!tab || tab.kind !== 'sql') return undefined;
      const draft = section.tabs.draft(tab.id);
      const error = [...section.runner(tab.id).results.messages()]
        .reverse()
        .find((message) => message.kind === 'error');
      const connection = section.connection(tab.connection);
      return {
        place: 'sql',
        ...(connection ? { connection: connection.name } : {}),
        engine: section.driverOf(tab.connection),
        script: draft.text,
        ...(error ? { error: translate(error.text, error.params) } : {}),
      };
    },
    use({ action, code }) {
      const tab = section.tabs.active();
      if (!tab) return;
      const database = section.tabs.draft(tab.id).database;
      section.newScript(tab.connection, {
        text: code,
        run: action === 'run',
        ...(database ? { database } : {}),
      });
    },
  };
}

/** Beside a MongoDB collection: its query or pipeline; a block becomes the one or the other. */
export function mongoHost(explorer: MongoExplorer): AiHost {
  return {
    context() {
      const target = explorer.target();
      const model = explorer.model();
      const fields = { filter: model.filter, projection: model.projection, sort: model.sort };
      const query =
        explorer.tab() === 'aggregations'
          ? pipelineText(explorer.aggregations.model().stages)
          : Object.entries(fields)
              .filter(([, value]) => value.trim())
              .map(([name, value]) => `${name}: ${value}`)
              .join('\n');
      return {
        place: 'mongo',
        connection: explorer.connection().name,
        ...(target ? { database: target.database, collection: target.collection } : {}),
        ...(query ? { query } : {}),
        ...(explorer.error() ? { error: explorer.error() } : {}),
      };
    },
    use({ action, code }) {
      const query = mongoQueryOf(code);
      if (query.kind === 'pipeline') {
        explorer.tab.set('aggregations');
        explorer.aggregations.model.update((model) => ({ ...model, text: query.text }));
        explorer.aggregations.applyText();
        if (action === 'run') void explorer.aggregations.runner.run();
        return;
      }
      explorer.tab.set('documents');
      explorer.model.update((model) => ({ ...model, filter: query.text }));
      if (action === 'run') void explorer.pager.find();
    },
  };
}
