import { signal } from '@angular/core';
import { GraphQLSchema, graphqlEndpoint } from '../../domain/graphql-schema';
import { KeyValue, RequestDraft, newRequest } from '../../domain/models';
import { RequestAncestor } from '../../domain/variables';
import type { WorkspaceState } from '../workspace-state';

/**
 * GraphQL schemas, by endpoint URL. As in Postman, they are loaded again in each session
 * rather than saved in the collection.
 */
export class SchemasStore {
  readonly schemas = signal<Readonly<Record<string, GraphQLSchema>>>({});
  readonly loading = signal(false);

  constructor(private readonly state: WorkspaceState) {}

  /** The schema loaded for an endpoint, whether written with http(s) or ws(s). */
  schemaFor(url: string): GraphQLSchema | undefined {
    return this.schemas()[graphqlEndpoint(url)];
  }
  /** Loads the schema of the active request's endpoint by introspection. */
  async loadActive() {
    const request = this.state.active()?.request;
    if (!request) return;
    await this.introspect(request, this.state.activeAncestors());
  }
  /**
   * Loads the schema of a subscription endpoint, over HTTP at the same address, with the
   * connection's headers, such as its authorization.
   */
  loadEndpoint(url: string, headers: readonly KeyValue[]) {
    return this.introspect(
      {
        ...newRequest(this.state.cases.files.id()),
        protocol: 'graphql',
        url: graphqlEndpoint(url),
        headers: headers.filter((row) => row.enabled && row.key).map((row) => ({ ...row })),
      },
      [],
    );
  }
  private async introspect(request: RequestDraft, ancestors: readonly RequestAncestor[]) {
    if (this.loading()) return;
    this.loading.set(true);
    const state = this.state;
    try {
      await state.guard(async () => {
        const schema = await state.cases.introspect(
          request,
          {
            workspace: state.workspaceId(),
            environment: state.environmentRows(),
            globals: state.globalRows(),
            ancestors,
          },
          state.cases.files.id(),
        );
        this.schemas.update((schemas) => ({
          ...schemas,
          [graphqlEndpoint(request.url)]: schema,
        }));
        state.notice.set('Schema loaded');
      });
    } finally {
      this.loading.set(false);
    }
  }
}
