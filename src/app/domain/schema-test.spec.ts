import { ExecutionResponse } from './models';
import {
  SCHEMA_SAMPLES,
  SCHEMA_TEST_NAME,
  jsonBody,
  schemaSamples,
  schemaTest,
  withSchemaTest,
} from './schema-test';

const response = (body: string, more: Partial<ExecutionResponse> = {}): ExecutionResponse =>
  ({
    status: 200,
    statusText: 'OK',
    headers: [],
    body,
    time: 1,
    size: 1,
    ...more,
  }) as unknown as ExecutionResponse;

describe('the JSON Schema of responses', () => {
  it('reads only complete JSON bodies', () => {
    expect(jsonBody(response('{"a":1}'))).toEqual({ value: { a: 1 } });
    expect(jsonBody(response('null'))).toEqual({ value: null });
    expect(jsonBody(response('<html>'))).toBeUndefined();
    expect(jsonBody(response('{"a":', { truncated: true }))).toBeUndefined();
    expect(jsonBody(response('e30=', { bodyEncoding: 'base64' }))).toBeUndefined();
    expect(jsonBody(undefined)).toBeUndefined();
  });

  it('takes the response shown first and the others once each, up to the limit', () => {
    const shown = response('{"n":0}');
    const others = [
      response('{"n":0}'),
      response('{"n":1}'),
      response('oops'),
      response('{"n":0}'),
    ];
    expect(schemaSamples(shown, others)).toEqual([{ n: 0 }, { n: 1 }, { n: 0 }]);
    expect(schemaSamples(response('text'), others)).toEqual([]);
    const many = Array.from({ length: 40 }, (_, n) => response(`{"n":${n + 1}}`));
    expect(schemaSamples(shown, many)).toHaveLength(SCHEMA_SAMPLES);
  });

  it('writes a test that replaces the one generated before', () => {
    const first = schemaTest({ type: 'object' }, 1);
    expect(first).toContain('read from 1 response.');
    expect(first).toContain(`pm.test(${JSON.stringify(SCHEMA_TEST_NAME)}, () => {`);
    expect(first).toContain('pm.response.to.have.jsonSchema(schema);');
    expect(withSchemaTest('', first)).toBe(`${first}\n`);
    const script = withSchemaTest("pm.test('mine', () => {});\n\n\n", first);
    expect(script).toBe(`pm.test('mine', () => {});\n\n${first}\n`);
    const second = schemaTest({ type: 'array' }, 5);
    const replaced = withSchemaTest(`${script}// after\n`, second);
    expect(replaced).toBe(`pm.test('mine', () => {});\n\n${second}\n// after\n`);
    expect(replaced).not.toContain('"object"');
  });
});
