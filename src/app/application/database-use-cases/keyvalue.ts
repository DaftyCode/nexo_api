import type { KvScanPage, KvText, KvValue } from '../../domain/db/keyvalue';
import { ExecutionPort } from '../ports';

/** What a key tab asks of its keys: a pattern, a type, where the last page stopped. */
export interface KvQuery {
  pattern?: string;
  type?: string;
  cursor?: string;
  count?: number;
}

/** A change to a key (`db.kv.write`). */
export interface KvChange {
  key: KvText;
  action: 'set' | 'rename' | 'expire' | 'delete' | 'put' | 'remove';
  type?: string;
  value?: unknown;
  field?: unknown;
  score?: number;
  index?: number;
  fields?: unknown[];
  to?: KvText;
  ttlMs?: number;
  confirm?: boolean;
}

/** What a command of the console answers. */
export interface KvReply {
  reply: unknown;
  elapsedMs: number;
}

/** What the person confirmed of a command: a change on production, or a dangerous name typed. */
export interface KvConfirmation {
  confirm?: boolean;
  confirmName?: string;
}

/**
 * Redis and Valkey (DB-35) on a session opened with `statements.open`: keys by pages of
 * `SCAN`, a key's value by its type, changes, and the commands of the console. The
 * application applies the rules of the connection to each one.
 */
export class DatabaseKeyValueCases {
  constructor(private readonly api: ExecutionPort) {}

  scan(workspace: string, session: string, query: KvQuery) {
    const clean = Object.fromEntries(
      Object.entries(query).filter(([, value]) => value !== undefined && value !== ''),
    );
    return this.api.execute<KvScanPage>('db.kv.scan', { workspace, session, ...clean });
  }

  get(workspace: string, session: string, key: KvText, cursor?: string) {
    return this.api.execute<KvValue>('db.kv.get', {
      workspace,
      session,
      key,
      ...(cursor ? { cursor } : {}),
    });
  }

  write(workspace: string, session: string, change: KvChange) {
    return this.api.execute<{ key: KvText; done: boolean }>('db.kv.write', {
      workspace,
      session,
      ...change,
    });
  }

  command(workspace: string, session: string, line: string, confirmation: KvConfirmation = {}) {
    return this.api.execute<KvReply>('db.kv.command', {
      workspace,
      session,
      line,
      ...(confirmation.confirm ? { confirm: true } : {}),
      ...(confirmation.confirmName ? { confirmName: confirmation.confirmName } : {}),
    });
  }
}
