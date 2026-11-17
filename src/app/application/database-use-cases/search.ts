import { DataHit, ObjectHit } from '../../domain/db/search';
import { ExecutionPort, PreferencePort } from '../ports';

const RECENT = 'db.searches';
/** Searches remembered on this computer. */
const KEPT = 10;

/** What `db.search` is asked: objects by name, or a value in the data of tables. */
export interface SearchRequest {
  mode: 'metadata' | 'data';
  text: string;
  kinds?: readonly string[];
  code?: boolean;
  schemas?: readonly string[];
  max?: number;
  tables?: readonly { schema?: string; name: string; path?: readonly string[] }[];
  caseSensitive?: boolean;
  wholeWord?: boolean;
  columns?: readonly ('text' | 'number')[];
  maxRows?: number;
  confirm?: boolean;
}

export interface SearchAnswer {
  objects?: ObjectHit[];
  data?: DataHit[];
  more?: boolean;
}

/**
 * The database search (DB-18): `db.search` on a session, cancelled by its statement's name,
 * and the texts searched lately, kept on this computer.
 */
export class DatabaseSearchCases {
  constructor(
    private readonly api: ExecutionPort,
    private readonly preferences: PreferencePort,
  ) {}

  search(workspace: string, session: string, statement: string, request: SearchRequest) {
    return this.api.execute<SearchAnswer>('db.search', {
      workspace,
      session,
      statement,
      ...request,
    });
  }

  recent(): string[] {
    try {
      const stored: unknown = JSON.parse(this.preferences.read(RECENT) ?? '[]');
      return Array.isArray(stored) ? stored.filter((text) => typeof text === 'string') : [];
    } catch {
      return [];
    }
  }
  remember(text: string) {
    const kept = [text, ...this.recent().filter((other) => other !== text)].slice(0, KEPT);
    this.preferences.write(RECENT, JSON.stringify(kept));
  }
}
