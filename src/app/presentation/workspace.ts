import {
  ChangeDetectionStrategy,
  Component,
  inject,
  afterNextRender,
  signal,
  HostListener,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormField, form } from '@angular/forms/signals';
import { WorkspaceState } from './workspace-state';
import { RequestEditor } from './request-editor';
import { ResponseView } from './response-view';
import { ToolsPanel } from './tools-panel';
import { WorkspaceDocument, CollectionItem } from '../domain/models';

@Component({
  imports: [FormField, DatePipe, RequestEditor, ResponseView, ToolsPanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-workspace',
  styleUrl: './workspace.scss',
  templateUrl: './workspace.html',
})
export class Workspace {
  protected readonly state = inject(WorkspaceState);
  protected readonly dialogs = signal('');
  protected readonly formModel = signal({
    name: '',
    content: '',
    email: '',
    password: '',
    workspace: '',
    environment: '',
    search: '',
    authMode: 'login',
  });
  protected readonly fields = form(this.formModel);
  protected readonly nav = [
    { id: 'collections', icon: '▤', label: 'Collections' },
    { id: 'environments', icon: '◫', label: 'Environments' },
    { id: 'history', icon: '◷', label: 'History' },
    { id: 'runner', icon: '▷', label: 'Runner' },
    { id: 'realtime', icon: '⇄', label: 'Protocols' },
    { id: 'mocks', icon: '◇', label: 'Mocks' },
    { id: 'datasets', icon: '▦', label: 'Datasets' },
    { id: 'git', icon: '⑂', label: 'Git' },
    { id: 'mcp', icon: '⌘', label: 'MCP' },
    { id: 'settings', icon: '⚙', label: 'Settings' },
  ];
  protected readonly collapsed = signal<string[]>([]);
  constructor() {
    afterNextRender(() => void this.state.initialize());
  }
  @HostListener('window:keydown', ['$event']) protected shortcuts(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void this.state.send();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void this.state.saveActive();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 't') {
      event.preventDefault();
      this.state.newTab();
    }
  }
  protected setSection(id: string) {
    this.state.section.set(id);
  }
  protected toggle(id: string) {
    this.collapsed.update((list) =>
      list.includes(id) ? list.filter((x) => x !== id) : [...list, id],
    );
  }
  protected method(item: CollectionItem) {
    return typeof item.request === 'object' ? String(item.request['method'] ?? 'GET') : 'GET';
  }
  protected async submitDialog() {
    const m = this.formModel();
    if (this.dialogs() === 'collection') await this.state.createCollection(m.name);
    if (this.dialogs() === 'import') await this.state.importContent(m.content);
    if (this.dialogs() === 'workspace')
      await this.state.guard(async () => {
        await this.state.cases.api.createWorkspace(m.name);
        this.state.workspaces.set(await this.state.cases.api.workspaces());
      });
    if (!this.state.error()) this.dialogs.set('');
  }
  protected async file(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) this.formModel.update((m) => ({ ...m, content: '' }));
    if (file) {
      const content = await this.state.cases.files.read(file);
      await this.state.importContent(content);
      if (!this.state.error()) this.dialogs.set('');
    }
  }
  protected async login() {
    const m = this.formModel();
    await this.state.authenticate(
      this.state.health()?.setupRequired ? 'register' : (m.authMode as 'login' | 'register'),
      { name: m.name, email: m.email, password: m.password },
    );
  }
  protected async selectWorkspace(event: Event) {
    await this.state.selectWorkspace((event.target as HTMLSelectElement).value);
  }
  protected selectEnvironment(event: Event) {
    this.state.environmentId.set((event.target as HTMLSelectElement).value);
  }
  protected search(event: Event) {
    this.state.filter.set((event.target as HTMLInputElement).value);
  }
  protected duplicate(document: WorkspaceDocument) {
    void this.state.guard(async () => {
      await this.state.cases.createDocument(
        this.state.workspaceId(),
        document.kind,
        `${document.name} copy`,
        structuredClone(document.value),
      );
      await this.state.refresh();
    });
  }
  protected folder(document: WorkspaceDocument) {
    void this.state.addFolder(document, 'New folder');
  }
}
