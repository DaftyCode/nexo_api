import { KillMode, LockList, SessionList, readLocks, readSessions } from '../../domain/db/admin';
import { ExecutionPort } from '../ports';

/** Names of the runs, to cancel one that hangs. */
let runs = 0;
const statement = () => `admin-${++runs}`;

/**
 * The administration of a server (DB-21): the sessions open on it, who waits for whom, and
 * cancelling the statement of a session or ending it, asked on a session of Nexo on that
 * server. Cancelling and ending are always confirmed; on production, with the id typed.
 */
export class DatabaseAdminCases {
  constructor(private readonly api: ExecutionPort) {}

  async sessions(workspace: string, session: string): Promise<SessionList> {
    const answer = await this.api.execute('db.sessions', {
      workspace,
      session,
      statement: statement(),
    });
    return readSessions(answer);
  }

  async locks(workspace: string, session: string): Promise<LockList> {
    const answer = await this.api.execute('db.locks', {
      workspace,
      session,
      statement: statement(),
    });
    return readLocks(answer);
  }

  /** Whether the server did it: `false` when the session was already gone. */
  async kill(
    workspace: string,
    session: string,
    target: string,
    mode: KillMode,
    typed?: string,
  ): Promise<boolean> {
    const answer = await this.api.execute<{ done?: boolean }>('db.session.kill', {
      workspace,
      session,
      statement: statement(),
      target,
      mode,
      confirm: true,
      ...(typed ? { confirmName: typed } : {}),
    });
    return answer?.done !== false;
  }
}
