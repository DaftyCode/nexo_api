import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ApiPort } from '../application/ports';
import { Health, Session, Workspace, WorkspaceDocument } from '../domain/models';
@Injectable()
export class HttpApi implements ApiPort {
  private readonly http = inject(HttpClient);
  private base = '';
  private token = '';
  async initialize() {
    if (typeof window === 'undefined') return;
    if ('__TAURI_INTERNALS__' in window) {
      const { invoke } = await import('@tauri-apps/api/core');
      const info = await invoke<{ base_url: string; token: string }>('desktop_info');
      this.base = info.base_url;
      this.token = info.token;
    } else this.token = sessionStorage.getItem('nexo.session') ?? '';
  }
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let headers = new HttpHeaders({ 'x-nexo-client': 'nexo' });
    if (this.token) headers = headers.set('Authorization', `Bearer ${this.token}`);
    try {
      return await firstValueFrom(
        this.http.request<T>(method, `${this.base}/api${path}`, {
          body,
          headers,
          transferCache: false,
        }),
      );
    } catch (error) {
      if (error instanceof HttpErrorResponse)
        throw new Error(
          error.error?.error ??
            (error.status === 0
              ? 'Cannot reach the Nexo backend. Start the backend service.'
              : `Request failed (${error.status})`),
        );
      throw error;
    }
  }
  health() {
    return this.request<Health>('GET', '/health');
  }
  async authenticate(
    mode: 'login' | 'register',
    credentials: { email: string; password: string; name: string },
  ) {
    const session = await this.request<Session>('POST', `/auth/${mode}`, credentials);
    this.token = session.token;
    sessionStorage.setItem('nexo.session', this.token);
    return session;
  }
  async signOut() {
    await this.request('POST', '/auth/logout', {});
    this.token = '';
    sessionStorage.removeItem('nexo.session');
  }
  workspaces() {
    return this.request<Workspace[]>('GET', '/workspaces');
  }
  createWorkspace(name: string) {
    return this.request<Workspace>('POST', '/workspaces', { name });
  }
  async documents(workspace: string) {
    const result = await this.request<WorkspaceDocument[]>(
      'GET',
      `/documents?workspace=${encodeURIComponent(workspace)}`,
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
  execute<T>(operation: string, payload: unknown) {
    return this.request<T>('POST', `/execute/${encodeURIComponent(operation)}`, payload);
  }
  git<T>(operation: string, payload: unknown) {
    return this.request<T>('POST', `/git/${encodeURIComponent(operation)}`, payload);
  }
  members(workspace: string) {
    return this.request<unknown[]>('GET', `/workspaces/${encodeURIComponent(workspace)}/members`);
  }
  async addMember(workspace: string, email: string, role: string) {
    await this.request('POST', `/workspaces/${encodeURIComponent(workspace)}/members`, {
      email,
      role,
    });
  }
  revisions(id: string) {
    return this.request<
      { revision: number; changed_at: number; actor_id: string; value: WorkspaceDocument }[]
    >('GET', `/documents/${encodeURIComponent(id)}/revisions`);
  }
  async putSecret(name: string, value: string) {
    await this.request('PUT', `/secrets/${encodeURIComponent(name)}`, { value });
  }
  async removeSecret(name: string) {
    await this.request('DELETE', `/secrets/${encodeURIComponent(name)}`);
  }
}
