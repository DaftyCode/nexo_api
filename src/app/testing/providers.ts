import { provideRouter } from '@angular/router';
import { LANGUAGE, languageProviders } from '../composition/language-providers';
import { LanguageUseCases } from '../application/language-use-cases';
import { APPEARANCE, WORKSPACE } from '../composition/providers';
import { AppearanceUseCases } from '../application/appearance-use-cases';
import { WorkspaceUseCases } from '../application/workspace-use-cases';
import { ApiPort, FilePort } from '../application/ports';
import { WorkspaceDocument } from '../domain/models';
export function testProviders() {
  const documents: WorkspaceDocument[] = [];
  const api: ApiPort = {
    async initialize() {},
    async health() {
      return {
        name: 'Nexo API',
        version: 'test',
        mode: 'local',
        setupRequired: false,
        allowSignup: false,
        capabilities: [],
      };
    },
    async authenticate() {
      return {
        token: 'fixture',
        actor: { id: 'local', email: 'test@nexo.test', name: 'Test' },
        expires_at: 0,
      };
    },
    async signOut() {},
    async workspaces() {
      return [{ id: 'local', name: 'Test workspace', role: 'owner' }];
    },
    async createWorkspace(name) {
      return { id: 'fixture', name, role: 'owner' };
    },
    async documents() {
      return documents;
    },
    async save(document) {
      const saved = { ...document, revision: document.revision + 1 };
      const index = documents.findIndex((d) => d.id === document.id);
      if (index < 0) documents.push(saved);
      else documents[index] = saved;
      return saved;
    },
    async remove() {},
    async execute<T>() {
      return {} as T;
    },
    async git<T>() {
      return {} as T;
    },
    async members() {
      return [];
    },
    async addMember() {},
    async revisions() {
      return [];
    },
    async putSecret() {},
    async removeSecret() {},
  };
  let id = 0;
  const files: FilePort = {
    id: () => `fixture-${++id}`,
    async read(file) {
      return file.text();
    },
    download() {},
  };
  return [
    provideRouter([]),
    ...languageProviders(),
    { provide: LANGUAGE, useValue: new LanguageUseCases({ load: () => 'en', save() {} }) },
    { provide: WORKSPACE, useValue: new WorkspaceUseCases(api, files) },
    {
      provide: APPEARANCE,
      useValue: new AppearanceUseCases({ loadTemplate: () => undefined, saveTemplate() {} }),
    },
  ];
}
