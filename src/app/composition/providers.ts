import { InjectionToken, inject } from '@angular/core';
import { WorkspaceUseCases } from '../application/workspace-use-cases';
import { HttpApi } from '../infrastructure/http-api';
import { BrowserFiles } from '../infrastructure/browser-files';
import { BrowserPreferences } from '../infrastructure/browser-preferences';
import { BrowserAppearance } from '../infrastructure/browser-appearance';
import { AppearanceUseCases } from '../application/appearance-use-cases';
import { IntegrationUseCases } from '../application/integration-use-cases';
import { DataUseCases } from '../application/data-use-cases';
import { ProtocolUseCases } from '../application/protocol-use-cases';
export const WORKSPACE = new InjectionToken<WorkspaceUseCases>('Nexo workspace use cases');
export const APPEARANCE = new InjectionToken<AppearanceUseCases>('Nexo appearance use cases');
export const INTEGRATION = new InjectionToken<IntegrationUseCases>('Nexo integration use cases');
export const DATA = new InjectionToken<DataUseCases>('Nexo dataset and mock use cases');
export const PROTOCOLS = new InjectionToken<ProtocolUseCases>('Nexo protocol use cases');
export const workspaceProviders = [
  HttpApi,
  BrowserFiles,
  BrowserPreferences,
  BrowserAppearance,
  { provide: APPEARANCE, useFactory: () => new AppearanceUseCases(inject(BrowserAppearance)) },
  { provide: INTEGRATION, useFactory: () => new IntegrationUseCases(inject(HttpApi)) },
  {
    provide: DATA,
    useFactory: () => {
      const files = inject(BrowserFiles);
      return new DataUseCases(inject(HttpApi), () => files.id());
    },
  },
  { provide: PROTOCOLS, useFactory: () => new ProtocolUseCases(inject(HttpApi)) },
  {
    provide: WORKSPACE,
    useFactory: () =>
      new WorkspaceUseCases(inject(HttpApi), inject(BrowserFiles), inject(BrowserPreferences)),
  },
];
