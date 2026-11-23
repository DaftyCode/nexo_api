import { SharedLink } from '../domain/shared';
import { ExecutionPort } from './ports';

/** What a poll found: the collections that took a teammate's changes, and every link. */
export interface SharedPoll {
  changed: string[];
  links: SharedLink[];
}

/**
 * The collections shared by the team (C-01): sharing one (a new file, sealed with a new team
 * key unless turned off), bringing one in, keeping them in step and choosing a side of what
 * both people changed. The team key goes to the vault in the backend; it comes back only
 * when the person asks for it to give it to a teammate.
 */
export class SharedUseCases {
  constructor(private readonly api: ExecutionPort) {}

  async status(workspace: string): Promise<SharedLink[]> {
    return (await this.api.execute<{ links: SharedLink[] }>('shared.status', { workspace })).links;
  }
  async poll(workspace: string): Promise<SharedPoll> {
    const answer = await this.api.execute<Partial<SharedPoll>>('shared.poll', { workspace });
    return { changed: answer.changed ?? [], links: answer.links ?? [] };
  }
  share(
    workspace: string,
    collection: string,
    path: string,
    encrypt: boolean,
    environments: readonly string[],
  ): Promise<{ collection: string; key?: string | null }> {
    return this.api.execute('shared.share', {
      workspace,
      collection,
      path,
      encrypt,
      environments,
    });
  }
  link(workspace: string, path: string, key?: string): Promise<{ collection: string }> {
    return this.api.execute('shared.link', {
      workspace,
      path,
      ...(key?.trim() ? { key: key.trim() } : {}),
    });
  }
  async sync(workspace: string, collection: string): Promise<SharedLink[]> {
    return (
      await this.api.execute<{ links: SharedLink[] }>('shared.sync', { workspace, collection })
    ).links;
  }
  async resolve(
    workspace: string,
    collection: string,
    id: string,
    keep: 'mine' | 'theirs',
  ): Promise<SharedLink[]> {
    return (
      await this.api.execute<{ links: SharedLink[] }>('shared.resolve', {
        workspace,
        collection,
        id,
        keep,
      })
    ).links;
  }
  async unlink(workspace: string, collection: string): Promise<SharedLink[]> {
    return (
      await this.api.execute<{ links: SharedLink[] }>('shared.unlink', { workspace, collection })
    ).links;
  }
  /** The team key, to give it to a teammate. */
  async key(workspace: string, collection: string): Promise<string> {
    return (
      (await this.api.execute<{ key?: string | null }>('shared.key', { workspace, collection }))
        .key ?? ''
    );
  }
}
