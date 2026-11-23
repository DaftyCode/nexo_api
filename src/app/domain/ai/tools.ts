/** A tool the model used while it answered, as the chat shows it. */
export interface AiStep {
  tool: string;
  /** What it was about: a table, a collection, a request. */
  detail?: string;
  failed?: boolean;
}

/** The tools Nexo offers, each with the words that say what it did (`ai.tool.<name>`). */
const KNOWN = new Set([
  'read_open',
  'read_response',
  'list_requests',
  'read_request',
  'sql_list_connections',
  'sql_list_tables',
  'sql_describe_table',
  'sql_query',
  'sql_explain',
  'mongo_list_connections',
  'mongo_list_databases',
  'mongo_list_collections',
  'mongo_find',
  'mongo_aggregate',
  'mongo_schema',
  'mongo_explain',
]);

/** The words that say what a tool did. */
export const stepLabel = (tool: string) => (KNOWN.has(tool) ? `ai.tool.${tool}` : 'ai.tool.other');

const word = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** The step of a call: its tool and what it was about. */
export function stepOf(tool: string, input: unknown): AiStep {
  const given = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const path = Array.isArray(given['path']) ? given['path'].map(word).filter(Boolean) : [];
  const place = [word(given['database']), word(given['collection'])].filter(Boolean);
  const detail =
    path.join('.') || place.join('.') || word(given['name']) || word(given['connection']);
  return { tool, ...(detail ? { detail } : {}) };
}

/** The steps kept with a message, leaving out what is not one. */
export function readSteps(value: unknown): AiStep[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const steps = value
    .filter(
      (step): step is AiStep =>
        !!step && typeof step === 'object' && typeof (step as AiStep).tool === 'string',
    )
    .map(({ tool, detail, failed }) => ({
      tool,
      ...(typeof detail === 'string' && detail ? { detail } : {}),
      ...(failed === true ? { failed } : {}),
    }));
  return steps.length ? steps : undefined;
}
