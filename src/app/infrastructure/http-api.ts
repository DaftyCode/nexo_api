import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ApiFailure, ApiPort, ExecuteArgs, RevisionEntry } from '../application/ports';
import { GitPayload } from '../application/payloads';
import { GitOperation } from '../application/operations';
import { Health, Workspace, WorkspaceDocument } from '../domain/models';
import { SecretSummary } from '../domain/secrets';

/**
 * Backend adapter. The desktop window receives a per-run token from the shell; the browser
 * relies on the HttpOnly session cookie created by the launcher's one-time link.
 */
@Injectable()
export class HttpApi implements ApiPort {
  private readonly http = inject(HttpClient);
  private base = '';
  private token = '';
  async initialize() {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
    const { invoke } = await import('@tauri-apps/api/core');
    // The desktop shell reports a startup failure of its local service as an error.
    const info = await invoke<{ base_url: string; token: string }>('desktop_info').catch(
      (error: unknown) => {
        throw new ApiFailure(String(error), 'unavailable', 0);
      },
    );
    this.base = info.base_url;
    this.token = info.token;
  }
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let headers = new HttpHeaders({ 'x-nexo-client': 'nexo' });
    if (this.token) headers = headers.set('Authorization', `Bearer ${this.token}`);
    try {
      return await firstValueFrom(
        this.http.request<T>(method, `${this.base}/api${path}`, { body, headers }),
      );
    } catch (error) {
      if (error instanceof HttpErrorResponse) {
        const payload = error.error as { error?: string; code?: string; detail?: unknown } | null;
        if (error.status === 0)
          throw new ApiFailure(
            'Cannot reach the Nexo backend. Start the backend service.',
            'unreachable',
            0,
          );
        throw new ApiFailure(
          payload?.error ?? `Request failed (${error.status})`,
          payload?.code ?? 'http',
          error.status,
          payload?.detail,
        );
      }
      throw error;
    }
  }
  health() {
    return this.request<Health>('GET', '/health');
  }
  async signOut() {
    await this.request('POST', '/session/close', {});
  }
  workspaces() {
    return this.request<Workspace[]>('GET', '/workspaces');
  }
  createWorkspace(name: string) {
    return this.request<Workspace>('POST', '/workspaces', { name });
  }
  renameWorkspace(id: string, name: string) {
    return this.request<Workspace>('PUT', `/workspaces/${encodeURIComponent(id)}`, { name });
  }
  async deleteWorkspace(id: string) {
    await this.request('DELETE', `/workspaces/${encodeURIComponent(id)}`);
  }
  document(id: string) {
    return this.request<WorkspaceDocument>('GET', `/documents/${encodeURIComponent(id)}`);
  }
  async documents(workspace: string) {
    const result = await this.request<WorkspaceDocument[]>(
      'GET',
      `/documents?workspace=${encodeURIComponent(workspace)}&lite=true`,
    );
    if (
      !Array.isArray(result) ||
      result.some((d) => typeof d.id !== 'string' || typeof d.revision !== 'number')
    )
      throw new Error('Invalid workspace response');
    return result;
  }
  save(document: WorkspaceDocument) {
    return this.request<WorkspaceDocument>('PUT', '/documents', document);
  }
  async remove(document: WorkspaceDocument) {
    await this.request(
      'DELETE',
      `/documents/${encodeURIComponent(document.id)}?revision=${document.revision}`,
    );
  }
  execute<T>(...[operation, payload]: ExecuteArgs) {
    return this.request<T>('POST', `/execute/${encodeURIComponent(operation)}`, payload);
  }
  git<T>(operation: GitOperation, payload: GitPayload) {
    return this.request<T>('POST', `/git/${encodeURIComponent(operation)}`, payload);
  }
  revisions(id: string) {
    return this.request<RevisionEntry[]>('GET', `/documents/${encodeURIComponent(id)}/revisions`);
  }
  async putSecret(name: string, value?: string, allowedHosts?: string[]) {
    await this.request('PUT', `/secrets/${encodeURIComponent(name)}`, { value, allowedHosts });
  }
  async removeSecret(name: string) {
    await this.request('DELETE', `/secrets/${encodeURIComponent(name)}`);
  }
  async secrets() {
    return (await this.request<{ secrets?: SecretSummary[] }>('GET', '/secrets')).secrets ?? [];
  }
}
