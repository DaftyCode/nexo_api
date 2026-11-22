import { signal } from '@angular/core';
import { clientList, infoSections, replyText, typedConfirmation } from '../../domain/db/keyvalue';
import type { KeysRun } from './keys-run';

/** A command of the console and what it answered. */
export interface ConsoleEntry {
  line: string;
  text: string;
  error?: boolean;
  elapsedMs?: number;
}

/** Commands kept in the console's history, and lines of its log. */
const HISTORY = 100;
const LOG = 200;

/**
 * The console of a keys tab (DB-35) and the server's view: a command per line, answered as
 * redis-cli answers it, with its history; a dangerous command waits for its name typed; a
 * change on production, for a confirmation. The server's view reads `INFO`, `CLIENT LIST`
 * and `SLOWLOG GET` with the same session.
 */
export class KeysConsole {
  readonly log = signal<readonly ConsoleEntry[]>([]);
  readonly history = signal<readonly string[]>([]);
  readonly running = signal(false);
  /** A dangerous command that waits for its name typed. */
  readonly waiting = signal<{ line: string; name: string } | undefined>(undefined);
  readonly info = signal<ReturnType<typeof infoSections>>([]);
  readonly clients = signal<ReturnType<typeof clientList>>([]);
  readonly slow = signal<readonly unknown[]>([]);

  constructor(private readonly run: KeysRun) {}

  private add(entry: ConsoleEntry) {
    this.log.update((log) => [...log, entry].slice(-LOG));
  }

  /** Runs a line; `confirmName` is the dangerous command's name, typed. */
  async send(line: string, confirmName?: string) {
    const text = line.trim();
    if (!text || this.running()) return;
    this.waiting.set(undefined);
    if (!confirmName)
      this.history.update((all) => [...all.filter((each) => each !== text), text].slice(-HISTORY));
    this.running.set(true);
    try {
      const cases = await this.run.cases();
      const answer = await this.ask(text, { confirmName }).catch(async (error: unknown) => {
        const message = this.run.section.state.describe(error);
        const name = typedConfirmation(message);
        if (name) {
          this.waiting.set({ line: text, name });
          return undefined;
        }
        const production = /asks to confirm each change/.test(message);
        if (production && this.run.section.state.confirm('db.edit.confirmProduction'))
          return cases.command(this.run.workspace(), this.run.session, text, {
            confirm: true,
            confirmName,
          });
        throw error;
      });
      if (answer) {
        const failed = typeof answer.reply === 'object' && answer.reply !== null;
        this.add({
          line: text,
          text: replyText(answer.reply),
          error: failed && 'error' in (answer.reply as object),
          elapsedMs: answer.elapsedMs,
        });
      }
    } catch (error) {
      this.add({ line: text, text: this.run.section.state.describe(error), error: true });
    } finally {
      this.running.set(false);
    }
  }

  private async ask(line: string, confirmation: { confirmName?: string }) {
    const cases = await this.run.cases();
    return cases.command(this.run.workspace(), this.run.session, line, confirmation);
  }

  clear() {
    this.log.set([]);
  }

  /** Reads the server's view. */
  async server() {
    try {
      const [info, clients, slow] = await Promise.all([
        this.ask('INFO', {}),
        this.ask('CLIENT LIST', {}),
        this.ask('SLOWLOG GET 20', {}),
      ]);
      this.info.set(infoSections(String(info.reply ?? '')));
      this.clients.set(clientList(String(clients.reply ?? '')));
      this.slow.set(Array.isArray(slow.reply) ? slow.reply : []);
    } catch (error) {
      this.run.error.set(this.run.section.state.describe(error));
    }
  }
}
