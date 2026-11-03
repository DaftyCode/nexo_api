import { InjectionToken, inject } from '@angular/core';
import { WorkspaceUseCases } from '../application/workspace-use-cases';
import { HttpApi } from '../infrastructure/http-api';
import { BrowserFiles } from '../infrastructure/browser-files';
export const WORKSPACE = new InjectionToken<WorkspaceUseCases>('Nexo workspace use cases');
export const workspaceProviders = [
  HttpApi,
  BrowserFiles,
  {
    provide: WORKSPACE,
    useFactory: () => new WorkspaceUseCases(inject(HttpApi), inject(BrowserFiles)),
  },
];
