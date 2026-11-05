import { AuthDraft, readAuth, writeAuth } from './auth';

/**
 * A collection root or a folder: both hold `variable`, `auth` and `event` (scripts).
 */
export type SettingsGroup = Readonly<Record<string, unknown>>;

/** Editable view of the authorization and scripts of a collection or a folder. */
export interface CollectionSettingsModel {
  auth: AuthDraft;
  prerequest: string;
  tests: string;
}

function scriptText(group: SettingsGroup | undefined, listen: string): string {
  const stored = group?.['event'];
  const events = Array.isArray(stored) ? (stored as unknown[]) : [];
  const event = events.find(
    (entry): entry is { listen: string; script?: { exec?: unknown } } =>
      !!entry && typeof entry === 'object' && (entry as { listen?: unknown }).listen === listen,
  );
  const exec = event?.script?.exec;
  return Array.isArray(exec) ? exec.join('\n') : typeof exec === 'string' ? exec : '';
}

/**
 * Reads the settings of a collection root or, with `folder`, of a folder. Without a stored
 * authorization a folder inherits its parent's, while a collection has none.
 */
export function readCollectionSettings(
  group: SettingsGroup | undefined,
  folder = false,
): CollectionSettingsModel {
  return {
    auth: readAuth(group?.['auth'], folder ? 'inherit' : 'noauth'),
    prerequest: scriptText(group, 'prerequest'),
    tests: scriptText(group, 'test'),
  };
}

/**
 * The authorization to store, or `undefined` to store none: a folder then inherits its
 * parent's, and a collection root has nothing to inherit, so "No auth" needs no entry.
 * Types without dedicated fields (OAuth 2, Digest…) keep every stored value.
 */
export function collectionAuth(model: CollectionSettingsModel, folder = false): unknown {
  if (!folder && model.auth.type === 'noauth') return undefined;
  return writeAuth(model.auth);
}

/** Replaces the pre-request and test scripts, keeping any other events. */
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
