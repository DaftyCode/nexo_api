import type { ExecuteArgs, ExecutionPort, PageExitPort } from '../ports';

/**
 * The database sessions this page opened and has not closed, seen on their way to the
 * engine, so that leaving the page closes every one of them. The engine would otherwise keep
 * them until they are idle, each holding a connection to its server and counting against
 * the limit of sessions open at once.
 */
export class DbOpenSessions implements ExecutionPort {
  /** The workspace of each open session, by its name. */
  private readonly open = new Map<string, string | undefined>();

  constructor(private readonly api: ExecutionPort) {}

  /** The names of the sessions open. */
  names(): string[] {
    return [...this.open.keys()];
  }

  /** Every call goes on as it came, its answer untouched and not delayed. */
  execute<T>(...args: ExecuteArgs): Promise<T> {
    if (args[0] === 'db.disconnect') this.open.delete(args[1].session);
    if (args[0] !== 'db.connect') return this.api.execute<T>(...args);
    const { session, workspace } = args[1];
    // The engine closes a session of the same name before it opens the new one.
    this.open.delete(session);
    return this.api.execute<T>(...args).then((answer) => {
      this.open.set(session, workspace);
      return answer;
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
