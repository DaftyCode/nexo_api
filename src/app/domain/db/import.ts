/**
 * Connections brought from other tools (DB-25): DBeaver's `data-sources.json`, pgAdmin's
 * `servers.json`, MySQL Workbench's `connections.xml`, a list of engine URLs, and Nexo's own
 * export. The interface reads the file the person chose; nothing reads paths. Passwords never
 * come: the imported connections ask for them, and the report says what came and what did
 * not, with the reason. The readers are in `import/`.
 */
import { ConnectionImport, IMPORT_MAX_BYTES, ImportBuilder } from './import/builder';
import { readDbeaver } from './import/dbeaver';
import { readNexoConnections } from './import/nexo';
import { readPgAdmin } from './import/pgadmin';
import { readUrlList } from './import/urls';
import { readWorkbench } from './import/workbench';

export * from './import/builder';
export { exportConnections } from './import/nexo';

/** Reads JSON, or nothing when the text is not. */
function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Reads the connections of a file of another tool, or of Nexo, by what it holds: throws a
 * message when it is none Nexo knows.
 */
export function readConnectionFile(text: string, newId: () => string): ConnectionImport {
  if (text.length > IMPORT_MAX_BYTES) throw new Error('The file is too large to import');
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (!trimmed) throw new Error('The file has no connections');
  if (trimmed.startsWith('<')) return readWorkbench(trimmed, new ImportBuilder('workbench', newId));
  const parsed = json(trimmed);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const value = parsed as Record<string, unknown>;
    if (value['nexo'] === 'connections')
      return readNexoConnections(value, new ImportBuilder('nexo', newId));
    if (value['Servers']) return readPgAdmin(value, new ImportBuilder('pgadmin', newId));
    if (value['connections']) return readDbeaver(value, new ImportBuilder('dbeaver', newId));
    throw new Error('Nexo does not know the connections of this file');
  }
  return readUrlList(trimmed, new ImportBuilder('urls', newId));
}
