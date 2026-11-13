import { InjectionToken } from '@angular/core';
import { TRANSLOCO_LOADER } from '@jsverse/transloco';
import { TestTranslations } from './translations';
import { provideRouter } from '@angular/router';
import { LANGUAGE, languageProviders } from '../composition/language-providers';
import { LanguageUseCases } from '../application/language-use-cases';
import {
  APPEARANCE,
  DATA,
  INTEGRATION,
  MONGO,
  TRANSFER_FILES,
  PROTOCOLS,
  REPORTS,
  WORKSPACE,
} from '../composition/providers';
import { ReportUseCases } from '../application/report-use-cases';
import { DataUseCases } from '../application/data-use-cases';
import { ProtocolUseCases } from '../application/protocol-use-cases';
import { MongoUseCases } from '../application/mongo-use-cases';
import { IntegrationUseCases } from '../application/integration-use-cases';
import { AppearanceUseCases } from '../application/appearance-use-cases';
import { WorkspaceUseCases } from '../application/workspace-use-cases';
import { ApiPort, FilePort } from '../application/ports';
import { WorkspaceDocument } from '../domain/models';
import { TestTransferFiles } from './mongo-transfer';

/** What the fake engine answers to an operation: a value, or a function of the payload. */
export type FakeResponse = unknown | ((payload: Record<string, unknown>) => unknown);

/** The in-memory API behind `testProviders`, with what it was asked. */
export interface TestApi extends ApiPort {
  readonly documentsStore: WorkspaceDocument[];
  readonly calls: { operation: string; payload: Record<string, unknown> }[];
  readonly gitCalls: { operation: string; payload: unknown }[];
  readonly downloads: { name: string; content: string }[];
  /** The text of each report sent to the printer, and how many were released. */
  readonly printed: string[];
  released: number;
  /** Answers by operation, set before or during a test. */
  readonly responses: Record<string, FakeResponse>;
  secretNames: string[];
}
export const TEST_API = new InjectionToken<TestApi>('TEST_API');

/** Answers that match the engine's shapes, so screens can render without one. */
const defaults: Record<string, FakeResponse> = {
  'oauth2.tokens': { tokens: [] },
  'mock.list': [],
  'cookies.list': { cookies: [] },
  'git.remote.list': { remotes: [] },
};

export function testProviders(responses: Record<string, FakeResponse> = {}) {
  const documents: WorkspaceDocument[] = [];
  const answers: Record<string, FakeResponse> = { ...defaults, ...responses };
  const api: TestApi = {
    documentsStore: documents,
    calls: [],
    gitCalls: [],
    downloads: [],
    printed: [],
    released: 0,
    responses: answers,
    secretNames: [],
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
      // A new list each time, as the engine returns.
      return [...documents];
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
    async remove(document) {
      const index = documents.findIndex((d) => d.id === document.id);
      if (index >= 0) documents.splice(index, 1);
    },
    async execute<T>(operation: string, payload: unknown) {
      const body = (payload ?? {}) as Record<string, unknown>;
      api.calls.push({ operation, payload: body });
      const answer = answers[operation];
      const value = typeof answer === 'function' ? await answer(body) : answer;
      return (value ?? {}) as T;
    },
    async git<T>(operation: string, payload: unknown) {
      api.gitCalls.push({ operation, payload });
      const answer = answers[`git.${operation}`];
      const value = typeof answer === 'function' ? await answer(payload as never) : answer;
      return (value ?? {}) as T;
    },
    async revisions() {
      return [];
    },
    async putSecret(name) {
      if (!api.secretNames.includes(name)) api.secretNames.push(name);
    },
    async removeSecret(name) {
      api.secretNames = api.secretNames.filter((secret) => secret !== name);
    },
    async secrets() {
      return api.secretNames.map((name) => ({ name, allowedHosts: [] }));
    },
  } as TestApi;
  let id = 0;
  const files: FilePort = {
    id: () => `fixture-${++id}`,
    async read(file) {
      return file.text();
    },
    async readBase64(file) {
      return btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())));
    },
    download(name, content) {
      api.downloads.push({ name, content: String(content) });
    },
  };
  return [
    provideRouter([]),
    ...languageProviders(),
    { provide: TRANSLOCO_LOADER, useClass: TestTranslations },
    { provide: TEST_API, useValue: api },
    { provide: LANGUAGE, useValue: new LanguageUseCases({ load: () => 'en', save() {} }) },
    { provide: WORKSPACE, useValue: new WorkspaceUseCases(api, files) },
    { provide: INTEGRATION, useValue: new IntegrationUseCases(api) },
    { provide: DATA, useValue: new DataUseCases(api, files.id) },
    { provide: PROTOCOLS, useValue: new ProtocolUseCases(api) },
    { provide: TRANSFER_FILES, useValue: new TestTransferFiles() },
    {
      provide: MONGO,
      useValue: (
        (cases) => () =>
          Promise.resolve(cases)
      )(new MongoUseCases(api, files.id)),
    },
    {
      provide: REPORTS,
      useValue: new ReportUseCases(
        {
          async print(sheet) {
            api.printed.push(sheet.textContent ?? '');
          },
          release() {
            api.released++;
          },
        },
        () => Date.UTC(2026, 10, 9, 10, 30),
      ),
    },
    {
      provide: APPEARANCE,
      useValue: new AppearanceUseCases({
        loadTemplate: () => undefined,
        saveTemplate() {},
        loadLayout: () => undefined,
        saveLayout() {},
        loadSections: () => undefined,
        saveSections() {},
      }),
    },
  ];
}
