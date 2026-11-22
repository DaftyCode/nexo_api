import { Signal, computed } from '@angular/core';
import type { ProtocolUseCases } from '../../application/protocol-use-cases';
import { WatchPipelineError, watchLabel, watchOptions } from '../../domain/mongo-watch';
import { isMongoConnection } from '../../domain/mongo';
import { readDbConnection } from '../../domain/db/connection';
import { WorkspaceDocument } from '../../domain/models';
import { resolveVariables } from '../../domain/variables';
import type { ProtocolSettings } from '../protocol-settings';
import type { WorkspaceState } from '../workspace-state';

/** Channels or patterns written in a field, separated by commas or spaces. */
export function channelList(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((name) => name.trim())
    .filter(Boolean);
}

/** A saved connection of Redis or Valkey. */
export function isRedisConnection(document: WorkspaceDocument): boolean {
  return document.kind === 'connection' && readDbConnection(document.value).driver === 'redis';
}

/**
 * What the protocol panel follows in a database: a MongoDB change stream or a Redis
 * subscription (DB-35). The saved connections it can follow, what it follows in one line,
 * and opening it with the variables of the active environment.
 */
export class PanelWatch {
  /** The saved MongoDB connections of the workspace. */
  readonly connections = computed(() => this.state.documents().filter(isMongoConnection));
  /** The saved Redis and Valkey connections. */
  readonly redis = computed(() => this.state.documents().filter(isRedisConnection));
  /** Whether the panel follows a database instead of connecting to a URL. */
  readonly active = computed(() => ['mongodb', 'redis'].includes(this.model().protocol));
  /** The connection and what it follows, where the other protocols have their URL. */
  readonly label = computed(() => {
    const m = this.model();
    if (m.protocol === 'redis') {
      const connection = this.redis().find((d) => d.id === m.redisConnection);
      const followed = [...channelList(m.channels), ...channelList(m.patterns)].join(', ');
      return `${connection?.name ?? ''} · ${followed}`;
    }
    const connection = this.connections().find((d) => d.id === m.mongoConnection);
    return `${connection?.name ?? ''} · ${watchLabel(m)}`;
  });

  constructor(
    private readonly state: WorkspaceState,
    private readonly protocols: ProtocolUseCases,
    private readonly model: Signal<ProtocolSettings>,
  ) {}

  /** Opens the change stream or the subscription; read and closed like the other connections. */
  open() {
    const m = this.model();
    if (m.protocol === 'redis') {
      const redis = this.redis().find((d) => d.id === m.redisConnection);
      if (!redis) throw new Error('Choose a saved connection');
      return this.protocols.subscribe(this.state.workspaceId(), redis, this.state.scopes(), {
        channels: channelList(m.channels),
        patterns: channelList(m.patterns),
      });
    }
    const connection = this.connections().find((d) => d.id === m.mongoConnection);
    if (!connection) throw new Error('Choose a saved connection');
    const scopes = this.state.scopes();
    let options;
    try {
      options = watchOptions(m, (text) => resolveVariables(text, scopes));
    } catch (error) {
      if (error instanceof WatchPipelineError) throw new Error(error.key, { cause: error });
      throw error;
    }
    return this.protocols.watch(this.state.workspaceId(), connection, scopes, options);
  }
}
