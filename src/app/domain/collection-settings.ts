import { Collection } from './models';

/** Editable view of the configuration stored at the root of a collection. */
export interface CollectionSettingsModel {
  authType: string;
  token: string;
  username: string;
  password: string;
  key: string;
  value: string;
  in: string;
  prerequest: string;
  tests: string;
}

const authFields: Record<string, (keyof CollectionSettingsModel)[]> = {
  bearer: ['token'],
  basic: ['username', 'password'],
  apikey: ['key', 'value', 'in'],
};

function scriptText(collection: Collection | undefined, listen: string): string {
  const events = Array.isArray(collection?.['event']) ? (collection['event'] as unknown[]) : [];
  const event = events.find(
    (entry): entry is { listen: string; script?: { exec?: unknown } } =>
      !!entry && typeof entry === 'object' && (entry as { listen?: unknown }).listen === listen,
  );
  const exec = event?.script?.exec;
  return Array.isArray(exec) ? exec.join('\n') : typeof exec === 'string' ? exec : '';
}

export function readCollectionSettings(
  collection: Collection | undefined,
): CollectionSettingsModel {
  const auth = (collection?.['auth'] ?? {}) as Record<string, unknown>;
  const type = typeof auth['type'] === 'string' ? auth['type'] : 'noauth';
  const rows = Array.isArray(auth[type])
    ? (auth[type] as { key?: unknown; value?: unknown }[])
    : [];
  const value = (key: string, fallback = '') => {
    const row = rows.find((entry) => entry?.key === key);
    return row?.value == null ? fallback : String(row.value);
  };
  return {
    authType: type,
    token: value('token'),
    username: value('username'),
    password: value('password'),
    key: value('key', 'X-API-Key'),
    value: value('value'),
    in: value('in', 'header'),
    prerequest: scriptText(collection, 'prerequest'),
    tests: scriptText(collection, 'test'),
  };
}

/** Auth in the collection format, or `undefined` when requests should not inherit any. */
export function collectionAuth(model: CollectionSettingsModel): unknown {
  const fields = authFields[model.authType];
  if (!fields) return undefined;
  return {
    type: model.authType,
    [model.authType]: fields.map((key) => ({ key, value: model[key], type: 'string' })),
  };
}

/** Replaces the pre-request and test scripts, keeping any other collection events. */
export function collectionEvents(model: CollectionSettingsModel, existing: unknown): unknown {
  const others = (Array.isArray(existing) ? existing : []).filter(
    (entry) =>
      !entry ||
      typeof entry !== 'object' ||
      !['prerequest', 'test'].includes((entry as { listen?: unknown }).listen as string),
  );
  const scripts = [
    ['prerequest', model.prerequest],
    ['test', model.tests],
  ]
    .filter(([, source]) => source.trim())
    .map(([listen, source]) => ({
      listen,
      script: { type: 'text/javascript', exec: source.split('\n') },
    }));
  const events = [...others, ...scripts];
  return events.length ? events : undefined;
}
