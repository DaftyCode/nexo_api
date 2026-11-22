import { describe, expect, it } from 'vitest';
import {
  RestBodyError,
  curlOf,
  hitsTable,
  restBlockAt,
  restBlocks,
  restBody,
  takesLines,
} from './rest-console';

const TEXT = `GET _cat/indices?v

POST shop/_search
{
  "query": {"match": {"name": "lamp"}}
}

post _bulk
{"index": {"_index": "shop"}}
{"name": "x"}
`;

describe('the console of Query DSL', () => {
  it('reads each request with its body and finds the one at the cursor', () => {
    const blocks = restBlocks(TEXT);
    expect(blocks.map((block) => `${block.method} ${block.path}`)).toEqual([
      'GET _cat/indices?v',
      'POST shop/_search',
      'POST _bulk',
    ]);
    expect(blocks[0].body).toBe('');
    expect(JSON.parse(blocks[1].body)).toEqual({ query: { match: { name: 'lamp' } } });
    expect(restBlockAt(blocks, TEXT.indexOf('"query"'))?.path).toBe('shop/_search');
    expect(restBlockAt(blocks, 2)?.path).toBe('_cat/indices?v');
    expect(restBlockAt(blocks, TEXT.length)?.path).toBe('_bulk');
    expect(restBlocks('nothing here')).toEqual([]);
    expect(restBlockAt([], 0)).toBeUndefined();
  });

  it('sends one JSON, or the lines of _bulk and _msearch as they are', () => {
    const [get, search, bulk] = restBlocks(TEXT);
    expect(restBody(get)).toBeUndefined();
    expect(restBody(search)).toEqual({ query: { match: { name: 'lamp' } } });
    expect(restBody(bulk)).toBe('{"index": {"_index": "shop"}}\n{"name": "x"}');
    expect(takesLines('shop/_msearch?x=1')).toBe(true);
    expect(takesLines('_msearch/template')).toBe(true);
    expect(takesLines('shop/_search')).toBe(false);
    expect(() => restBody({ ...search, body: '{oops' })).toThrow(RestBodyError);
  });

  it('writes a request as cURL without the secret', () => {
    const [get, search, bulk] = restBlocks(TEXT);
    expect(curlOf(get, 'https://es:9200/')).toBe('curl -X GET "https://es:9200/_cat/indices?v"');
    const curl = curlOf({ ...search, body: `{"q": "it's"}` }, 'http://es:9200');
    expect(curl).toContain("-H 'Content-Type: application/json'");
    expect(curl).toContain(`--data-binary '{"q": "it'\\''s"}'`);
    expect(curlOf(bulk, 'http://es')).toContain('application/x-ndjson');
  });

  it('shows the hits of a search as a table', () => {
    const table = hitsTable({
      hits: {
        hits: [
          { _id: '1', _source: { name: 'Lamp', user: { city: 'Lima' }, tags: ['a'] } },
          { _id: '2', _source: { name: 'Desk' } },
        ],
      },
    });
    expect(table).toEqual({
      columns: ['_id', 'name', 'user.city', 'tags'],
      rows: [
        ['1', 'Lamp', 'Lima', '["a"]'],
        ['2', 'Desk', '', ''],
      ],
    });
    expect(hitsTable({ acknowledged: true })).toBeUndefined();
    expect(hitsTable(undefined)).toBeUndefined();
  });
});
