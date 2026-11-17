/**
 * The administration of a database server (DB-21), as DBeaver's session and lock managers:
 * the sessions open on it (`db.sessions`) and who waits for whom (`db.locks`), read
 * defensively, filtered as the person asks, and the waits as a tree with the session that
 * blocks on top and the ones that wait for it below.
 */
export type KillMode = 'cancel' | 'terminate';

export interface ServerSession {
  id: string;
  user?: string;
  database?: string;
  application?: string;
  client?: string;
  state?: string;
  /** Seconds in its state, or running its statement. */
  seconds?: number;
  wait?: string;
  sql?: string;
  active: boolean;
  /** The session Nexo asks on: never cancelled nor ended from here. */
  own: boolean;
}
export interface SessionList {
  sessions: ServerSession[];
  /** The privilege the user lacks to see every session. */
  privilege?: string;
}

export interface LockWait {
  waiting: string;
  blocking: string;
  object?: string;
  mode?: string;
  seconds?: number;
  waitingUser?: string;
  waitingSql?: string;
  blockingUser?: string;
  blockingSql?: string;
}
export interface LockList {
  waits: LockWait[];
  privilege?: string;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) =>
  typeof value === 'string' && value ? value : typeof value === 'number' ? String(value) : '';
const optional = <K extends string>(key: K, value: unknown): Partial<Record<K, string>> =>
  text(value) ? ({ [key]: text(value) } as Record<K, string>) : {};
const seconds = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? { seconds: value } : {};

export function readSessions(value: unknown): SessionList {
  const source = record(value);
  const sessions = (Array.isArray(source['sessions']) ? source['sessions'] : []).flatMap(
    (item): ServerSession[] => {
      const session = record(item);
      if (!text(session['id'])) return [];
      return [
        {
          id: text(session['id']),
          ...optional('user', session['user']),
          ...optional('database', session['database']),
          ...optional('application', session['application']),
          ...optional('client', session['client']),
          ...optional('state', session['state']),
          ...seconds(session['seconds']),
          ...optional('wait', session['wait']),
          ...optional('sql', session['sql']),
          active: session['active'] === true,
          own: session['own'] === true,
        },
      ];
    },
  );
  return { sessions, ...optional('privilege', source['privilege']) };
}

export function readLocks(value: unknown): LockList {
  const source = record(value);
  const waits = (Array.isArray(source['waits']) ? source['waits'] : []).flatMap(
    (item): LockWait[] => {
      const wait = record(item);
      if (!text(wait['waiting']) || !text(wait['blocking'])) return [];
      return [
        {
          waiting: text(wait['waiting']),
          blocking: text(wait['blocking']),
          ...optional('object', wait['object']),
          ...optional('mode', wait['mode']),
          ...seconds(wait['seconds']),
          ...optional('waitingUser', wait['waitingUser']),
          ...optional('waitingSql', wait['waitingSql']),
          ...optional('blockingUser', wait['blockingUser']),
          ...optional('blockingSql', wait['blockingSql']),
        },
      ];
    },
  );
  return { waits, ...optional('privilege', source['privilege']) };
}

/** The sessions shown: the idle ones left out when asked (never the own), and a text found. */
export function shownSessions(
  sessions: readonly ServerSession[],
  filter: { text: string; idle: boolean },
): ServerSession[] {
  const wanted = filter.text.trim().toLowerCase();
  return sessions.filter((session) => {
    if (!filter.idle && !session.active && !session.own) return false;
    if (!wanted) return true;
    const fields = [session.id, session.user, session.database, session.application];
    fields.push(session.client, session.state, session.wait, session.sql);
    return fields.some((field) => field?.toLowerCase().includes(wanted));
  });
}

/** A row of the tree of waits: a session, how deep it is, and what it waits for, if it does. */
export interface WaitRow {
  session: string;
  user?: string;
  sql?: string;
  depth: number;
  /** What this session waits for its parent to release; none at the top. */
  wait?: LockWait;
  /** Other sessions wait for this one. */
  blocks: boolean;
}

/**
 * The waits as a tree: each session that blocks others and waits for none on top, the ones
 * that wait for it below, and so on. Sessions that wait for each other (a deadlock) are put
 * at the top once each, from the lowest id.
 */
export function waitTree(waits: readonly LockWait[]): WaitRow[] {
  const below = new Map<string, LockWait[]>();
  for (const wait of waits) below.set(wait.blocking, [...(below.get(wait.blocking) ?? []), wait]);
  const waiting = new Set(waits.map((wait) => wait.waiting));
  const byId = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  const blockers = [...below.keys()].sort(byId);
  const roots = blockers.filter((id) => !waiting.has(id));
  const rows: WaitRow[] = [];
  const seen = new Set<string>();
  const visit = (session: string, depth: number, wait?: LockWait) => {
    seen.add(session);
    const top = waits.find((each) => each.blocking === session);
    rows.push({
      session,
      user: wait?.waitingUser ?? top?.blockingUser,
      sql: wait?.waitingSql ?? top?.blockingSql,
      depth,
      ...(wait ? { wait } : {}),
      blocks: below.has(session),
    });
    for (const child of below.get(session) ?? [])
      if (!seen.has(child.waiting)) visit(child.waiting, depth + 1, child);
  };
  for (const root of roots) visit(root, 0);
  for (const left of blockers) if (!seen.has(left)) visit(left, 0);
  return rows;
}

/** A duration as people read it: `45 s`, `3 min 5 s`, `2 h 10 min`. */
export function duration(seconds: number | undefined): string {
  if (seconds === undefined || seconds < 0) return '';
  const whole = Math.floor(seconds);
  if (whole < 60) return `${whole} s`;
  if (whole < 3600) return `${Math.floor(whole / 60)} min ${whole % 60} s`;
  return `${Math.floor(whole / 3600)} h ${Math.floor((whole % 3600) / 60)} min`;
}
