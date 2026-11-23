/**
 * The AI assistant (IA-01): off until the person turns it on, with the model run inside Nexo
 * or the key of a provider of their own (kept in the vault, never here). Its settings are of
 * this device; its conversations, documents of the workspace. Its parts: the local model,
 * the code of an answer and the tools it reads with.
 */
import { AiStep, readSteps } from './ai/tools';

export { MODEL_SIZES, byteSize, localReady } from './ai/local';
export type { LocalAiStatus } from './ai/local';
export { answerParts, codeActions, mongoQueryOf } from './ai/answer';
export type { AiCodeAction, AiUse, AnswerPart } from './ai/answer';
export { AI_ACTIONS, readSteps, stepLabel, stepOf } from './ai/tools';
export type { AiStep } from './ai/tools';
export type AiProvider = 'local' | 'anthropic' | 'openai' | 'gemini' | 'compatible';
export type AiEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** Where a conversation is held: beside a SQL script, a MongoDB collection or a request. */
export type AiPlace = 'sql' | 'mongo' | 'request';

export const AI_PROVIDERS: readonly { id: AiProvider; name: string }[] = [
  { id: 'local', name: 'ai.provider.local' },
  { id: 'anthropic', name: 'Anthropic (Claude)' },
  { id: 'openai', name: 'OpenAI (ChatGPT)' },
  { id: 'gemini', name: 'Google (Gemini)' },
  { id: 'compatible', name: 'ai.provider.compatible' },
];
export const AI_EFFORTS: readonly AiEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface AiSettings {
  enabled: boolean;
  provider: AiProvider;
  model: string;
  /** The address of a compatible server (`https://api.mistral.ai/v1`). */
  baseUrl: string;
  /** Anthropic only; empty leaves the model's own. */
  effort: AiEffort | '';
  /** A proxy profile to reach the provider through, by its id; empty goes directly. */
  proxy: string;
  /** The tools may read response bodies; off, bodies stay on this computer. */
  bodies: boolean;
}

/** The model each provider starts with; the others are chosen from its list. */
const FIRST_MODEL: Record<AiProvider, string> = {
  local: 'local',
  anthropic: 'claude-opus-5-5',
  openai: '',
  gemini: '',
  compatible: '',
};

/** The model inside Nexo first: nothing leaves the computer. */
export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: false,
  provider: 'local',
  model: FIRST_MODEL.local,
  baseUrl: '',
  effort: '',
  proxy: '',
  bodies: true,
};

const isProvider = (value: unknown): value is AiProvider =>
  AI_PROVIDERS.some((provider) => provider.id === value);
const isEffort = (value: unknown): value is AiEffort => AI_EFFORTS.includes(value as AiEffort);
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** The settings saved on this device; anything unreadable reads as the defaults. */
export function readAiSettings(saved: string | undefined): AiSettings {
  let value: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(saved ?? '{}');
    if (parsed && typeof parsed === 'object') value = parsed as Record<string, unknown>;
  } catch {
    // Kept as the defaults.
  }
  const provider = isProvider(value['provider']) ? value['provider'] : 'local';
  return {
    enabled: value['enabled'] === true,
    provider,
    model: text(value['model']) || FIRST_MODEL[provider],
    baseUrl: text(value['baseUrl']),
    effort: isEffort(value['effort']) ? value['effort'] : '',
    proxy: text(value['proxy']),
    bodies: value['bodies'] !== false,
  };
}

/** The settings after choosing another provider: its first model, the rest kept. */
export function withProvider(settings: AiSettings, provider: AiProvider): AiSettings {
  return {
    ...settings,
    provider,
    model: FIRST_MODEL[provider],
    effort: provider === 'anthropic' ? settings.effort : '',
  };
}

/** The vault secret with the key of a provider. */
export const aiKeyName = (provider: AiProvider) => `ai:${provider}`;

/**
 * What is missing before the assistant can answer; `undefined` when nothing is. `ready` says
 * the provider's key is in the vault, or, for the local model, that it is downloaded.
 */
export function aiMissing(settings: AiSettings, ready: boolean): string | undefined {
  if (!settings.enabled) return 'ai.missing.off';
  if (settings.provider === 'local') return ready ? undefined : 'ai.missing.local';
  if (settings.provider === 'compatible' && !settings.baseUrl) return 'ai.missing.address';
  if (settings.provider !== 'compatible' && !ready) return 'ai.missing.key';
  if (!settings.model) return 'ai.missing.model';
  return undefined;
}

export interface AiMessage {
  role: 'user' | 'assistant';
  text: string;
  /** What the model reasoned before its answer, where the provider shows it. */
  thinking?: string;
  /** Seconds it reasoned. */
  thought?: number;
  /** Why an answer failed, in the provider's or Nexo's words. */
  failed?: string;
  /** Why an answer ended early: `refusal`, `max_tokens`, `length`, `stopped`… */
  stop?: string;
  /** The tools it read with, in order. */
  steps?: AiStep[];
}

export interface AiConversation {
  id: string;
  title: string;
  place: AiPlace;
  messages: AiMessage[];
}

/** Seconds of reasoning between two instants in milliseconds, at least one. */
export function thoughtSeconds(from: number, to: number): number {
  return Math.max(1, Math.round((to - from) / 1000));
}

/** Messages a conversation keeps; past them a new one is started. */
export const MAX_CONVERSATION_MESSAGES = 200;

/** A conversation's name: the first line of its first question, cut to 60 characters. */
export function conversationTitle(question: string): string {
  const line = question.trim().split('\n')[0]?.trim() ?? '';
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/** What the end of an answer means to the person, when it ended before its time. */
export function stopNote(stop: string | undefined): string | undefined {
  switch (stop) {
    case 'refusal':
    case 'safety':
      return 'ai.stop.refusal';
    case 'max_tokens':
    case 'length':
      return 'ai.stop.length';
    case 'stopped':
      return 'ai.stop.stopped';
    case 'tools':
      return 'ai.stop.tools';
    case 'empty':
      return 'ai.stop.empty';
    default:
      return undefined;
  }
}

/** The instructions of the assistant in each place, in the language of the model. */
export function aiInstructions(place: AiPlace): string {
  const where = {
    sql: 'The person is writing SQL in the editor of a database connection.',
    mongo: 'The person is querying a MongoDB collection (filters, aggregation pipelines, shell).',
    request: 'The person is building and sending HTTP requests and reading their responses.',
  }[place];
  const reads = {
    sql: 'A question is about the connection open beside you, which read_open names: look for the tables it means there first (sql_list_tables, sql_describe_table). Only when the person says it is another database, or a table they name is not there, list the connections you can read with sql_list_connections and ask which one they mean; besides the open one, those are the ones the person let MCP agents read.',
    mongo:
      'A question is about the connection and collection open beside you, which read_open names: read them first. Only when the person says it is another database, or a collection they name is not there, list the connections you can read with mongo_list_connections and ask which one they mean; besides the open one, those are the ones the person let MCP agents read.',
    request: '',
  }[place];
  const code = {
    sql: 'Write each statement the person may run in its own ```sql block, for the engine of the connection: Nexo offers to open or run it.',
    mongo:
      'Write a MongoDB filter as a document, or a pipeline as an array, in a ```json block: Nexo offers to use or run it.',
    request:
      'Write tests with pm.test and pm.expect in one ```javascript block: Nexo offers to add it to the request’s tests.',
  }[place];
  return [
    'You are the assistant of Nexo, an API client and database tool that runs on the person’s computer.',
    where,
    'When the question is about what the person has open, read it first with the read_open tool, and read what else you need with the other tools; they only read.',
    reads,
    code,
    'Answer in the language the person writes in. Be concise; put code in fenced blocks with its language.',
    'Never invent results: say what you would check when you are not sure.',
  ]
    .filter(Boolean)
    .join(' ');
}

/** A conversation kept in the workspace: what its document holds. */
export function readConversation(document: {
  id: string;
  name: string;
  value?: unknown;
}): AiConversation {
  const value = (document.value ?? {}) as Record<string, unknown>;
  const place = ['sql', 'mongo', 'request'].includes(value['place'] as string)
    ? (value['place'] as AiPlace)
    : 'request';
  const messages = Array.isArray(value['messages']) ? value['messages'] : [];
  return {
    id: document.id,
    title: document.name,
    place,
    messages: messages
      .filter(
        (message): message is AiMessage =>
          !!message &&
          typeof message === 'object' &&
          ['user', 'assistant'].includes((message as AiMessage).role) &&
          typeof (message as AiMessage).text === 'string',
      )
      .map(({ role, text, thinking, thought, failed, stop, steps }) => ({
        role,
        text,
        ...(readSteps(steps) ? { steps: readSteps(steps) } : {}),
        ...(typeof thinking === 'string' && thinking ? { thinking } : {}),
        ...(typeof thought === 'number' ? { thought } : {}),
        ...(typeof failed === 'string' ? { failed } : {}),
        ...(typeof stop === 'string' ? { stop } : {}),
      })),
  };
}
