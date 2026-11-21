import { ApiFailure, failureCode } from '../ports';
import type { ExecuteArgs, ExecutionPort, PageExitPort } from '../ports';

/** Asks the person for the password of a connection; `undefined` when they decline. */
export type PasswordQuestion = (connection: string) => Promise<string | undefined>;

/**
 * The database sessions this page opened and has not closed, seen on their way to the
 * engine, so that leaving the page closes every one of them. The engine would otherwise keep
 * them until they are idle, each holding a connection to its server and counting against
 * the limit of sessions open at once.
 */
export class DbOpenSessions implements ExecutionPort {
  /** The workspace of each open session, by its name. */
  private readonly open = new Map<string, string | undefined>();
  private ask?: PasswordQuestion;

  constructor(private readonly api: ExecutionPort) {}

  /** The names of the sessions open. */
  names(): string[] {
    return [...this.open.keys()];
  }

  /**
   * Who asks for the password of a connection that keeps none (DB-25), when the engine says
   * a session of it needs one; the session then opens with it.
   */
  askPasswordsWith(ask: PasswordQuestion) {
    this.ask = ask;
  }

  /** Every call goes on as it came, its answer untouched and not delayed. */
  execute<T>(...args: ExecuteArgs): Promise<T> {
    if (args[0] === 'db.disconnect') this.open.delete(args[1].session);
    if (args[0] !== 'db.connect') return this.api.execute<T>(...args);
    const payload = args[1];
    const { session, workspace } = payload;
    // The engine closes a session of the same name before it opens the new one.
    this.open.delete(session);
    const opened = (answer: T) => {
      this.open.set(session, workspace);
      return answer;
    };
    // One step on the usual way: asking for a password only when the engine needs one.
    return this.api.execute<T>('db.connect', payload).then(opened, async (error: unknown) => {
      if (failureCode(error) !== 'database.password' || !this.ask) throw error;
      const detail = (error as ApiFailure).detail as { connection?: string } | undefined;
      const password = await this.ask(detail?.connection ?? '');
      if (password === undefined) throw error;
      return this.api.execute<T>('db.connect', { ...payload, password }).then(opened);
    });
  }

  /** Closes every open session with requests that outlive the page; how many it closed. */
  leave(exit: PageExitPort): number {
    const closed = this.open.size;
    for (const [session, workspace] of this.open)
      exit.send('db.disconnect', { session, ...(workspace ? { workspace } : {}) });
    this.open.clear();
    return closed;
  }
}
