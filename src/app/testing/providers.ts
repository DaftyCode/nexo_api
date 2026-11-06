import { provideRouter } from '@angular/router';
import { LANGUAGE, languageProviders } from '../composition/language-providers';
import { LanguageUseCases } from '../application/language-use-cases';
import { APPEARANCE, DATA, INTEGRATION, PROTOCOLS, WORKSPACE } from '../composition/providers';
import { DataUseCases } from '../application/data-use-cases';
import { ProtocolUseCases } from '../application/protocol-use-cases';
import { IntegrationUseCases } from '../application/integration-use-cases';
import { AppearanceUseCases } from '../application/appearance-use-cases';
import { WorkspaceUseCases } from '../application/workspace-use-cases';
import { ApiPort, FilePort } from '../application/ports';
import { WorkspaceDocument } from '../domain/models';
export function testProviders() {
  const documents: WorkspaceDocument[] = [];
  const api: ApiPort = {
    async initialize() {},
    async health() {
      return { name: 'Nexo API', version: 'test', mode: 'desktop', engineReady: true };
    },
    async signOut() {},
    async workspaces() {
      return [{ id: 'local', name: 'Test workspace' }];
    },
    async createWorkspace(name) {
      return { id: 'fixture', name };
    },
    async renameWorkspace(id, name) {
      return { id, name };
    },
    async deleteWorkspace() {},
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
    async document(id) {
      const found = documents.find((d) => d.id === id);
      if (!found) throw new Error('Not found');
      return found;
    },
    async remove() {},
    async execute<T>() {
      return {} as T;
    },
    async git<T>() {
      return {} as T;
    },
    async revisions() {
      return [];
    },
    async putSecret() {},
    async removeSecret() {},
    async secrets() {
      return [];
    },
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
    { provide: INTEGRATION, useValue: new IntegrationUseCases(api) },
    { provide: DATA, useValue: new DataUseCases(api, files.id) },
    { provide: PROTOCOLS, useValue: new ProtocolUseCases(api) },
    {
      provide: APPEARANCE,
      useValue: new AppearanceUseCases({
        loadTemplate: () => undefined,
        saveTemplate() {},
        loadLayout: () => undefined,
        saveLayout() {},
      }),
    },
  ];
}
