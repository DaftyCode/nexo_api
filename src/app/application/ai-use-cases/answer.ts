import { AiMessage, AiStep, stepOf, thoughtSeconds } from '../../domain/ai';
import type { AiContext, AiToolResult } from '../payloads';
import { ExecutionPort } from '../ports';

/** How often a running answer is asked what it gained. */
export const POLL = 120;

/** What an answer gained since the last time it was asked. */
interface Polled {
  text: string;
  next: number;
  thinking?: string;
  thinkingNext?: number;
  /** The tools the model waits for. */
  tools?: { id: string; name: string; input: unknown }[];
  done: boolean;
  stop?: string | null;
  error?: string | null;
}

/** An answer as far as it has come: its text, its reasoning and the tools it read with. */
export interface AiWritten {
  text: string;
  thinking: string;
  steps: AiStep[];
}

/** What the tools read with: the workspace, what is open, and whether bodies may go. */
export interface AiReading {
  workspace: string;
  context?: () => AiContext | undefined;
  bodies: boolean;
}

/** The clock of an answer: how it waits between polls, and what time it is. */
export interface AiClock {
  wait(milliseconds: number): Promise<void>;
  now(): number;
}

const copy = (answer: AiWritten): AiWritten => ({ ...answer, steps: [...answer.steps] });
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Runs the tools a model asked for, each with what is open; the steps say how each went. */
async function read(
  api: ExecutionPort,
  calls: NonNullable<Polled['tools']>,
  reading: AiReading,
  answer: AiWritten,
  written: (answer: AiWritten) => void,
): Promise<AiToolResult[]> {
  const results: AiToolResult[] = [];
  for (const call of calls) {
    const at = answer.steps.push(stepOf(call.name, call.input)) - 1;
    written(copy(answer));
    const context = reading.context?.();
    const input = call.input && typeof call.input === 'object' ? call.input : {};
    const result = await api
      .execute<{ text: string; error?: boolean }>('ai.tool', {
        workspace: reading.workspace,
        name: call.name,
        input: input as Record<string, unknown>,
        ...(context ? { context } : {}),
        bodies: reading.bodies,
      })
      .catch((error: unknown) => ({ text: reason(error), error: true }));
    if (result.error) answer.steps[at] = { ...answer.steps[at]!, failed: true };
    results.push({ id: call.id, text: result.text, ...(result.error ? { error: true } : {}) });
  }
  written(copy(answer));
  return results;
}

/**
 * Follows the answer `id` to its end: what it writes and reasons goes to `written`, and when
 * the model asks for tools, they run (`ai.tool`) and their answers go back (`ai.continue`).
 */
export async function follow(
  api: ExecutionPort,
  id: string,
  reading: AiReading,
  written: (answer: AiWritten) => void,
  clock: AiClock,
): Promise<AiMessage> {
  const answer: AiWritten = { text: '', thinking: '', steps: [] };
  let next = 0;
  let thought = 0;
  // When the reasoning began, and when the answer after it did.
  let began: number | undefined;
  let ended: number | undefined;
  for (;;) {
    const polled = await api.execute<Polled>('ai.poll', {
      id,
      after: next,
      thinkingAfter: thought,
    });
    if (polled.thinking) {
      answer.thinking += polled.thinking;
      began ??= clock.now();
    }
    if (polled.text) {
      answer.text += polled.text;
      if (began !== undefined) ended ??= clock.now();
    }
    if (polled.text || polled.thinking) written(copy(answer));
    next = polled.next ?? next;
    thought = polled.thinkingNext ?? thought;
    if (polled.tools?.length) {
      const results = await read(api, polled.tools, reading, answer, written);
      await api.execute('ai.continue', { id, results });
      continue;
    }
    if (polled.done) {
      // A model may end after reading and reasoning without a word: it is said.
      const natural = !polled.stop || polled.stop === 'end_turn' || polled.stop === 'stop';
      const empty = natural && !answer.text.trim() && !polled.error;
      return {
        role: 'assistant',
        text: answer.text,
        ...(began !== undefined
          ? { thinking: answer.thinking, thought: thoughtSeconds(began, ended ?? clock.now()) }
          : {}),
        ...(answer.steps.length ? { steps: answer.steps } : {}),
        ...(empty
          ? { stop: 'empty' }
          : polled.stop && polled.stop !== 'end_turn' && polled.stop !== 'stop'
            ? { stop: polled.stop }
            : {}),
        ...(polled.error ? { failed: polled.error } : {}),
      };
    }
    await clock.wait(POLL);
  }
}
