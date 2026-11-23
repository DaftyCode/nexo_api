import {
  AiConversation,
  AiMessage,
  AiPlace,
  AiProvider,
  AiSettings,
  LocalAiStatus,
  MAX_CONVERSATION_MESSAGES,
  aiInstructions,
  aiKeyName,
  conversationTitle,
  readAiSettings,
  localReady,
  readConversation,
  thoughtSeconds,
} from '../domain/ai';
import { WorkspaceDocument } from '../domain/models';
import { readProxyProfile } from '../domain/proxy';
import { DocumentRepositoryPort, ExecutionPort, PreferencePort, SecretVaultPort } from './ports';

/** The preference with the assistant's settings on this device. */
const SETTINGS = 'ai.settings';
/** How often a running answer is asked what it gained. */
const POLL = 120;
const KIND = 'ai-conversation';

/** What an answer gained since the last time it was asked. */
interface Polled {
  text: string;
  next: number;
  thinking?: string;
  thinkingNext?: number;
  done: boolean;
  stop?: string | null;
  error?: string | null;
}

/** An answer as far as it has come: its text and the reasoning before it. */
export interface AiWritten {
  text: string;
  thinking: string;
}

/** An answer being written: stop it, or wait for its end. */
export interface AiAnswer {
  stop(): void;
  /** How it ended: its text, why it stopped and why it failed. */
  readonly done: Promise<AiMessage>;
}

/** The AI assistant: its settings, the key of each provider, its models and its answers. */
export class AiUseCases {
  constructor(
    private readonly api: ExecutionPort,
    private readonly vault: Pick<SecretVaultPort, 'putSecret' | 'removeSecret' | 'secrets'>,
    private readonly preferences: PreferencePort,
    private readonly documents: Pick<
      DocumentRepositoryPort,
      'documents' | 'document' | 'save' | 'remove'
    >,
    private readonly wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((done) => setTimeout(done, milliseconds)),
    private readonly now: () => number = () => Date.now(),
  ) {}

  settings(): AiSettings {
    return readAiSettings(this.preferences.read(SETTINGS));
  }
  saveSettings(settings: AiSettings): void {
    this.preferences.write(SETTINGS, JSON.stringify(settings));
  }

  /** Whether the provider can answer: its key is in the vault, or the local model is there. */
  async hasKey(provider: AiProvider): Promise<boolean> {
    if (provider === 'local') return localReady(await this.localStatus());
    const name = aiKeyName(provider);
    return (await this.vault.secrets()).some((secret) => secret.name === name);
  }
  saveKey(provider: AiProvider, key: string): Promise<void> {
    return this.vault.putSecret(aiKeyName(provider), key.trim());
  }
  removeKey(provider: AiProvider): Promise<void> {
    return this.vault.removeSecret(aiKeyName(provider));
  }

  /** The model run inside Nexo: what is installed, what the computer has, what it needs. */
  localStatus(): Promise<LocalAiStatus> {
    return this.api.execute<LocalAiStatus>('ai.local.status', {});
  }
  /** Downloads the engine and a model (the one this computer runs best when none is said). */
  installLocal(model?: 'qwen3.5-9b' | 'qwen3.5-4b'): Promise<LocalAiStatus> {
    return this.api.execute<LocalAiStatus>('ai.local.install', model ? { model } : {});
  }
  useLocalFile(path: string): Promise<LocalAiStatus> {
    return this.api.execute<LocalAiStatus>('ai.local.file', { path });
  }
  removeLocal(): Promise<LocalAiStatus> {
    return this.api.execute<LocalAiStatus>('ai.local.remove', {});
  }

  /**
   * Where the provider is and how it is reached, as every call sends it: directly, or through
   * the proxy profile chosen (when it still exists). The local model is always on loopback.
   */
  private async reach(settings: AiSettings, workspace: string) {
    if (settings.provider === 'local') return { workspace, provider: settings.provider };
    const profile = settings.proxy
      ? await this.documents
          .document(settings.proxy)
          .then(readProxyProfile)
          .catch(() => undefined)
      : undefined;
    return {
      workspace,
      provider: settings.provider,
      ...(settings.provider === 'compatible' ? { baseUrl: settings.baseUrl } : {}),
      ...(profile ? { route: { via: profile.protocol, profile: profile.id } } : {}),
    };
  }

  /** The models the provider lists for the key. */
  async models(settings: AiSettings, workspace: string): Promise<{ id: string; name: string }[]> {
    const answer = await this.api.execute<{ models: { id: string; name: string }[] }>(
      'ai.models',
      await this.reach(settings, workspace),
    );
    return answer.models ?? [];
  }

  /**
   * Asks the conversation `messages` (ending with the question) and streams the answer to
   * `written` as it grows: the whole text and reasoning so far each time. The reasoning is
   * shown, never sent back to the model.
   */
  async ask(
    settings: AiSettings,
    workspace: string,
    place: AiPlace,
    messages: readonly AiMessage[],
    written: (answer: AiWritten) => void,
  ): Promise<AiAnswer> {
    const { id } = await this.api.execute<{ id: string }>('ai.chat', {
      ...(await this.reach(settings, workspace)),
      model: settings.model,
      ...(settings.provider === 'anthropic' && settings.effort ? { effort: settings.effort } : {}),
      system: aiInstructions(place),
      messages: messages
        .filter((message) => !message.failed)
        .map(({ role, text }) => ({ role, text })),
    });
    let stopped = false;
    const done = (async (): Promise<AiMessage> => {
      const answer: AiWritten = { text: '', thinking: '' };
      let next = 0;
      let thought = 0;
      // When the reasoning began, and when the answer after it did.
      let began: number | undefined;
      let ended: number | undefined;
      for (;;) {
        const polled = await this.api.execute<Polled>('ai.poll', {
          id,
          after: next,
          thinkingAfter: thought,
        });
        if (polled.thinking) {
          answer.thinking += polled.thinking;
          began ??= this.now();
        }
        if (polled.text) {
          answer.text += polled.text;
          if (began !== undefined) ended ??= this.now();
        }
        if (polled.text || polled.thinking) written({ ...answer });
        next = polled.next ?? next;
        thought = polled.thinkingNext ?? thought;
        if (polled.done) {
          return {
            role: 'assistant',
            text: answer.text,
            ...(began !== undefined
              ? { thinking: answer.thinking, thought: thoughtSeconds(began, ended ?? this.now()) }
              : {}),
            ...(polled.stop && polled.stop !== 'end_turn' && polled.stop !== 'stop'
              ? { stop: polled.stop }
              : {}),
            ...(polled.error ? { failed: polled.error } : {}),
          };
        }
        await this.wait(POLL);
      }
    })();
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        void this.api.execute('ai.stop', { id }).catch(() => undefined);
      },
      done,
    };
  }

  /** The conversations of a workspace, by name; each is read whole when it is opened. */
  async conversations(workspace: string): Promise<{ id: string; title: string }[]> {
    return (await this.documents.documents(workspace))
      .filter((document) => document.kind === KIND)
      .sort((a, b) => b.updated_at - a.updated_at)
      .map((document) => ({ id: document.id, title: document.name }));
  }

  /** A conversation, with the revision its next save is based on. */
  async conversation(id: string): Promise<AiConversation & { revision: number }> {
    const document = await this.documents.document(id);
    return { ...readConversation(document), revision: document.revision };
  }

  /**
   * Saves a conversation: a new one (without `revision`) gets its name from its first
   * question. Only the last messages are kept past the limit.
   */
  async save(
    workspace: string,
    conversation: Omit<AiConversation, 'title'> & { title?: string },
    revision?: number,
  ): Promise<{ id: string; revision: number }> {
    const messages = conversation.messages.slice(-MAX_CONVERSATION_MESSAGES);
    const first = messages.find((message) => message.role === 'user')?.text ?? '';
    const document: WorkspaceDocument = {
      id: conversation.id,
      workspace_id: workspace,
      kind: KIND,
      name: conversation.title || conversationTitle(first) || 'Conversation',
      revision: revision ?? 0,
      updated_at: 0,
      value: { place: conversation.place, messages },
    };
    const saved = await this.documents.save(document);
    return { id: saved.id, revision: saved.revision };
  }

  async remove(workspace: string, id: string, revision: number): Promise<void> {
    await this.documents.remove({
      id,
      workspace_id: workspace,
      kind: KIND,
      name: '',
      revision,
      updated_at: 0,
      value: {},
    });
  }
}
