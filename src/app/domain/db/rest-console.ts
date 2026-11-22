/**
 * The console of Query DSL of Elasticsearch and OpenSearch (DB-36), as Kibana's works: each
 * request is a line `METHOD path` followed by its JSON body, several in a tab; the one at the
 * cursor runs. The lines of `_bulk` and `_msearch` go as they are written (NDJSON).
 */

export const REST_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'PATCH'] as const;

/** A request of the console, with where it is in the text. */
export interface RestBlock {
  method: string;
  path: string;
  /** Its body as written: one JSON, or lines. */
  body: string;
  start: number;
  end: number;
}

const REQUEST_LINE = /^[ \t]*(GET|POST|PUT|DELETE|HEAD|PATCH)[ \t]+(\S+)[ \t]*$/i;

/** The requests of a text, in order. */
export function restBlocks(text: string): RestBlock[] {
  const blocks: RestBlock[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const found = REQUEST_LINE.exec(line);
    if (found) {
      blocks.push({
        method: found[1].toUpperCase(),
        path: found[2],
        body: '',
        start: offset,
        end: offset + line.length,
      });
    } else if (blocks.length) {
      const block = blocks.at(-1)!;
      block.body += (block.body ? '\n' : '') + line;
      if (line.trim()) block.end = offset + line.length;
    }
    offset += line.length + 1;
  }
  for (const block of blocks) block.body = block.body.trim();
  return blocks;
}

/** The request at `cursor`: the one it is in, else the last one before it. */
export function restBlockAt(blocks: readonly RestBlock[], cursor: number): RestBlock | undefined {
  return (
    blocks.find((block) => block.start <= cursor && cursor <= block.end) ??
    [...blocks].reverse().find((block) => block.start <= cursor) ??
    blocks[0]
  );
}

/** Whether a path takes lines of JSON instead of one document. */
export function takesLines(path: string): boolean {
  return (
    /(^|\/)_(bulk|msearch)(\/|\?|$)/.test(path.split('?')[0]) || /_msearch\/template/.test(path)
  );
}

export class RestBodyError extends Error {
  constructor(readonly detail: string) {
    super('db.rest.badBody');
  }
}

/** The body as it is sent: nothing, one JSON value, or the lines as text. */
export function restBody(block: RestBlock): unknown {
  if (!block.body) return undefined;
  if (takesLines(block.path)) return block.body;
  try {
    return JSON.parse(block.body) as unknown;
  } catch (error) {
    throw new RestBodyError(String((error as Error).message));
  }
}

/** The request as cURL writes it, without the connection's secret. */
export function curlOf(block: RestBlock, base: string): string {
  const url = `${base.replace(/\/+$/, '')}/${block.path.replace(/^\/+/, '')}`;
  const parts = [`curl -X ${block.method} "${url}"`];
  if (block.body) {
    const type = takesLines(block.path) ? 'application/x-ndjson' : 'application/json';
    parts.push(`-H 'Content-Type: ${type}'`);
    parts.push(
      `--data-binary '${block.body.replaceAll("'", "'\\''")}${takesLines(block.path) ? '\n' : ''}'`,
    );
  }
  return parts.join(' \\\n  ');
}

/** The hits of a search answer as a table: `_id` and the fields of each document, flattened. */
export function hitsTable(body: unknown): { columns: string[]; rows: string[][] } | undefined {
  const hits = (body as { hits?: { hits?: unknown[] } } | undefined)?.hits?.hits;
  if (!Array.isArray(hits)) return undefined;
  const flat = hits.map((hit) => {
    const record: Record<string, string> = { _id: String((hit as { _id?: unknown })._id ?? '') };
    const walk = (value: unknown, prefix: string) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [name, inner] of Object.entries(value)) walk(inner, `${prefix}${name}.`);
      } else
        record[prefix.slice(0, -1)] = typeof value === 'string' ? value : JSON.stringify(value);
    };
    walk((hit as { _source?: unknown })._source ?? {}, '');
    return record;
  });
  const columns = [...new Set(flat.flatMap((record) => Object.keys(record)))];
  return { columns, rows: flat.map((record) => columns.map((column) => record[column] ?? '')) };
}

/** The endpoints the console completes, with the indices of the cluster. */
export const REST_PATHS = [
  '_cat/indices?v',
  '_cat/nodes?v',
  '_cat/aliases?v',
  '_cat/shards?v',
  '_cluster/health',
  '_cluster/stats',
  '_nodes/stats',
  '_search',
  '_count',
  '_mapping',
  '_settings',
  '_doc',
  '_bulk',
  '_msearch',
  '_sql',
  '_sql/translate',
  '_analyze',
  '_aliases',
  '_index_template',
  '_data_stream',
  '_delete_by_query',
  '_update_by_query',
  '_refresh',
];
