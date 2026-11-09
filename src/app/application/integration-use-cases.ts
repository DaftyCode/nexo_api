import {
  DocumentRepositoryPort,
  ExecutionPort,
  RevisionEntry,
  SecretVaultPort,
  VersionControlPort,
} from './ports';
import { GitOperation } from './operations';
import { RequestDraft, WorkspaceDocument, toItem } from '../domain/models';
import { exportableCollection } from '../domain/sanitize';
import { GitRemote, RepositoryFile, repositoryImport } from '../domain/repository';
import { parseAllowedDomains } from '../domain/secrets';
import { RequestAncestor, toPortableRows } from '../domain/variables';

/** What a Git operation takes besides the workspace. */
export interface GitInput {
  branch?: string;
  message?: string;
  remote?: string;
  url?: string;
  rebase?: boolean;
  forceWithLease?: boolean;
}
export interface GitResult {
  success: boolean;
  stdout: string;
  stderr: string;
}
export interface PerformanceStatus {
  state: string;
  completed?: number;
  errors?: number;
  average?: number;
  p50?: number;
  p95?: number;
  elapsed?: number;
  summary?: { requests: number; errors: number; average: number; p95: number; rps: number };
}
export interface LoadTest {
  users: number;
  duration: number;
  profile: string;
  request: RequestDraft;
  variables: ReturnType<typeof toPortableRows>;
  globals: ReturnType<typeof toPortableRows>;
  ancestors: readonly RequestAncestor[];
}
export interface TokenRequest {
  url: string;
  grant: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  code: string;
  redirectUri: string;
  verifier: string;
}
export interface TokenResponse {
  status: number;
  body: Record<string, unknown>;
}

type IntegrationPorts = ExecutionPort &
  VersionControlPort &
  SecretVaultPort &
  Pick<DocumentRepositoryPort, 'revisions' | 'save'>;

/** Git, secrets, revisions, OAuth, MCP, code generation and load tests. */
export class IntegrationUseCases {
  constructor(private readonly api: IntegrationPorts) {}

  /** Writes collections to the workspace project, without literal credentials. */
  exportCollections(workspace: string, collections: readonly WorkspaceDocument[]) {
    return this.api.git('export', {
      workspace,
      files: collections.map((d) => ({ id: d.id, value: exportableCollection(d.value) })),
    });
  }
  git(
    workspace: string,
    operation: Exclude<GitOperation, 'export' | 'files'>,
    input: GitInput = {},
  ) {
    return this.api.git<GitResult>(operation, { workspace, ...input });
  }
  /** The remotes of the workspace project. */
  async remotes(workspace: string) {
    const { remotes } = await this.api.git<{ remotes: GitRemote[] }>('remote.list', {
      workspace,
    });
    return remotes ?? [];
  }
  /**
   * Brings the project's collections into the workspace after a pull or a clone: new ones
   * are added and changed ones updated, keeping the credentials the export masked. Those
   * only in the workspace stay.
   */
  async importRepository(workspace: string, documents: readonly WorkspaceDocument[]) {
    const { files } = await this.api.git<{ files: RepositoryFile[] }>('files', { workspace });
    const plan = repositoryImport(files, documents, workspace);
    for (const document of plan.save) await this.api.save(document);
    return plan;
  }

  secrets() {
    return this.api.secrets();
  }
  /**
   * Saves a secret with its allowed domains (empty allows every domain, as in Postman). The
   * value may be left empty for a saved secret: then only its domains change.
   */
  async saveSecret(name: string, value: string, allowedDomains = '', saved = false) {
    if (!name.trim()) throw new Error('Enter a secret name');
    if (!value && !saved) throw new Error('Enter the secret value');
    await this.api.putSecret(name, value || undefined, parseAllowedDomains(allowedDomains));
  }
  removeSecret(name: string) {
    if (!name.trim()) throw new Error('Enter a secret name');
    return this.api.removeSecret(name);
  }

  revisions(documentId: string): Promise<RevisionEntry[]> {
    if (!documentId) throw new Error('Choose a resource');
    return this.api.revisions(documentId);
  }
  /** Saves an earlier version as a new revision of the current document. */
  restoreRevision(previous: WorkspaceDocument, current: WorkspaceDocument | undefined) {
    if (!current) throw new Error('Document no longer exists');
    return this.api.save({ ...previous, revision: current.revision });
  }

  exchangeToken(workspace: string, input: TokenRequest) {
    if (!input.url.trim()) throw new Error('Enter the full token endpoint URL');
    const fields: Record<string, string> = {
      grant_type: input.grant,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      scope: input.scope,
    };
    if (input.code) fields[input.grant === 'refresh_token' ? 'refresh_token' : 'code'] = input.code;
    if (input.redirectUri) fields['redirect_uri'] = input.redirectUri;
    if (input.verifier) fields['code_verifier'] = input.verifier;
    return this.api.execute<TokenResponse>('oauth.token', { workspace, url: input.url, fields });
  }

  mcp(
    workspace: string,
    input: { url: string; method: string; params: unknown; headers: Record<string, string> },
  ) {
    return this.api.execute<unknown>('mcp.request', { workspace, ...input });
  }

  async generateCode(workspace: string, request: RequestDraft, language: string, variant: string) {
    const result = await this.api.execute<{ code: string }>('codegen', {
      workspace,
      request: toItem(request),
      language,
      variant,
    });
    return result.code;
  }

  startLoadTest(workspace: string, test: LoadTest) {
    return this.api.execute<{ id: string }>('performance', {
      workspace,
      users: test.users,
      duration: test.duration,
      profile: test.profile,
      request: toItem(test.request),
      variables: test.variables,
      globals: test.globals,
      context: { ancestors: test.ancestors },
      strictSSL: test.request.strictSSL,
      followRedirects: test.request.followRedirects,
    });
  }
  loadTestStatus(workspace: string, id: string) {
    return this.api.execute<PerformanceStatus>('performance', { workspace, id, action: 'status' });
  }
  cancelLoadTest(workspace: string, id: string) {
    return this.api.execute<PerformanceStatus>('performance.cancel', { workspace, id });
  }
}
