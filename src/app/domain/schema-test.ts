/**
 * JSON Schema of responses (B-08): the bodies a schema is read from, and the test that
 * checks it in every run. The test is a block of the request's test script between two
 * marker comments, so that generating it again replaces it instead of adding another.
 */
import { ExecutionResponse } from './models';

/** Responses a schema is read from, at most: the one shown and those of the history. */
export const SCHEMA_SAMPLES = 20;
export const SCHEMA_TEST_NAME = 'The response matches its JSON Schema';
const START = '// Nexo: JSON Schema test, read from';
const END = '// Nexo: end of the JSON Schema test.';

/** The body of a response parsed, when it is complete JSON and not binary. */
export function jsonBody(response: ExecutionResponse | undefined): { value: unknown } | undefined {
  if (!response || response.truncated || response.bodyEncoding === 'base64') return undefined;
  try {
    return { value: JSON.parse(response.body) };
  } catch {
    return undefined;
  }
}

/**
 * The samples of a schema: the response shown first, then the others, newest first, at most
 * `SCHEMA_SAMPLES`. A response alike to the one shown (the history keeps it too) is read once.
 */
export function schemaSamples(
  shown: ExecutionResponse,
  others: readonly ExecutionResponse[],
): unknown[] {
  const first = jsonBody(shown);
  if (!first) return [];
  const samples = [first.value];
  let repeated = false;
  for (const response of others) {
    if (samples.length >= SCHEMA_SAMPLES) break;
    if (!repeated && response.body === shown.body) {
      repeated = true;
      continue;
    }
    const parsed = jsonBody(response);
    if (parsed) samples.push(parsed.value);
  }
  return samples;
}

/** The test that checks a response against `schema`, read from `sampled` responses. */
export function schemaTest(schema: unknown, sampled: number): string {
  return [
    `${START} ${sampled} ${sampled === 1 ? 'response' : 'responses'}.`,
    `const schema = ${JSON.stringify(schema, null, 2)};`,
    `pm.test(${JSON.stringify(SCHEMA_TEST_NAME)}, () => {`,
    '  pm.response.to.have.jsonSchema(schema);',
    '});',
    END,
  ].join('\n');
}

/** The test script with the schema test, in place of the one generated before if there is one. */
export function withSchemaTest(script: string, test: string): string {
  const start = script.indexOf(START);
  const end = start < 0 ? -1 : script.indexOf(END, start);
  if (start >= 0 && end >= 0) return script.slice(0, start) + test + script.slice(end + END.length);
  const kept = script.trimEnd();
  return kept ? `${kept}\n\n${test}\n` : `${test}\n`;
}
