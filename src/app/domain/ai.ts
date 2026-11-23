/**
 * The AI assistant (IA-01): off until the person turns it on, with the key of a provider of
 * their own (kept in the vault, never here) or a server compatible with OpenAI's API. Its
 * settings are of this device; its conversations, documents of the workspace.
 */
export type AiProvider = 'anthropic' | 'openai' | 'gemini' | 'compatible';
export type AiEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** Where a conversation is held: beside a SQL script, a MongoDB collection or a request. */
export type AiPlace = 'sql' | 'mongo' | 'request';

export const AI_PROVIDERS: readonly { id: AiProvider; name: string }[] = [
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
}

/** The model each provider starts with; the others are chosen from its list. */
const FIRST_MODEL: Record<AiProvider, string> = {
  anthropic: 'claude-opus-5-5',
  openai: '',
  gemini: '',
  compatible: '',
};

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: false,
  provider: 'anthropic',
  model: FIRST_MODEL.anthropic,
  baseUrl: '',
  effort: '',
  proxy: '',
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
  const provider = isProvider(value['provider']) ? value['provider'] : 'anthropic';
  return {
    enabled: value['enabled'] === true,
    provider,
    model: text(value['model']) || FIRST_MODEL[provider],
    baseUrl: text(value['baseUrl']),
    effort: isEffort(value['effort']) ? value['effort'] : '',
    proxy: text(value['proxy']),
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

/** What is missing before the assistant can answer; `undefined` when nothing is. */
export function aiMissing(settings: AiSettings, hasKey: boolean): string | undefined {
  if (!settings.enabled) return 'ai.missing.off';
  if (settings.provider === 'compatible' && !settings.baseUrl) return 'ai.missing.address';
  if (settings.provider !== 'compatible' && !hasKey) return 'ai.missing.key';
  if (!settings.model) return 'ai.missing.model';
  return undefined;
}

export interface AiMessage {
  role: 'user' | 'assistant';
  text: string;
  /** Why an answer failed, in the provider's or Nexo's words. */
  failed?: string;
  /** Why an answer ended early: `refusal`, `max_tokens`, `length`, `stopped`… */
  stop?: string;
}

export interface AiConversation {
  id: string;
  title: string;
  place: AiPlace;
  messages: AiMessage[];
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
  return [
    'You are the assistant of Nexo, an API client and database tool that runs on the person’s computer.',
    where,
    'Answer in the language the person writes in. Be concise; put code in fenced blocks with its language.',
    'Never invent results: say what you would check when you are not sure.',
  ].join(' ');
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
      .map((message) => ({ ...message })),
  };
}
