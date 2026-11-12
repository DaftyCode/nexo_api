/** Connections exported from MongoDB Compass. */

import { formatMongoUri, type ParsedUri, parseMongoUri } from './uri';
import { CONNECTION_COLORS } from '../mongo';

/** A connection exported by MongoDB Compass ("Export Saved Connections"). */
export interface ImportedConnection {
  name: string;
  uri: string;
  password?: string;
  color?: string;
}

/**
 * Reads a file of connections exported by MongoDB Compass. Passwords of an unencrypted
 * export come out of the URI; those of an encrypted one cannot be read and must be typed.
 */
export function parseCompassExport(text: string): ImportedConnection[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('The file is not JSON');
  }
  const file = data as { type?: unknown; connections?: unknown };
  if (file?.type !== 'Compass Connections' || !Array.isArray(file.connections))
    throw new Error('The file is not an export of MongoDB Compass connections');
  return file.connections.flatMap((entry: unknown, index: number) => {
    const connection = entry as {
      connectionOptions?: { connectionString?: unknown };
      favorite?: { name?: unknown; color?: unknown };
    };
    const uri = connection?.connectionOptions?.connectionString;
    if (typeof uri !== 'string') return [];
    let parsed: ParsedUri;
    try {
      parsed = parseMongoUri(uri);
    } catch {
      return [];
    }
    const name = connection.favorite?.name;
    const color = /^color(\d+)$/.exec(String(connection.favorite?.color ?? ''));
    return [
      {
        name: typeof name === 'string' && name.trim() ? name.trim() : `Connection ${index + 1}`,
        uri: formatMongoUri(parsed.form),
        ...(parsed.password !== undefined ? { password: parsed.password } : {}),
        ...(color
          ? {
              color:
                CONNECTION_COLORS[(Math.max(1, Number(color[1])) - 1) % CONNECTION_COLORS.length],
            }
          : {}),
      },
    ];
  });
}
