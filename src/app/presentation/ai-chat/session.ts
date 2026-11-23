import { Injectable, signal } from '@angular/core';
import { AiMessage, AiPlace } from '../../domain/ai';

/** The conversation on screen; one without `revision` is not saved yet. */
export interface ShownConversation {
  id: string;
  revision?: number;
  messages: AiMessage[];
}
export const freshConversation = (): ShownConversation => ({
  id: crypto.randomUUID(),
  messages: [],
});

/** What a place showed in the chat: its conversation and the question being written. */
export interface ShownChat {
  workspace: string;
  conversation: ShownConversation;
  question: string;
}

/**
 * The chat as the person left it, while Nexo is open and in memory only: a SQL tab that opens
 * (also the one an answer runs its query in) shows the chat if it was open, with the same
 * conversation and question, and every place keeps the width dragged to.
 */
@Injectable({ providedIn: 'root' })
export class AiChatSession {
  /** The width dragged to; 0 is the width of its styles. */
  readonly width = signal(0);
  /** Whether the chat is open beside the SQL scripts: the same in every SQL tab. */
  readonly sql = signal(false);
  /** What each place showed last. */
  readonly shown = signal<Partial<Record<AiPlace, ShownChat>>>({});
}
