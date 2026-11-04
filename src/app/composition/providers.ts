import { InjectionToken, inject } from '@angular/core';
import { WorkspaceUseCases } from '../application/workspace-use-cases';
import { HttpApi } from '../infrastructure/http-api';
import { BrowserFiles } from '../infrastructure/browser-files';
import { BrowserAppearance } from '../infrastructure/browser-appearance';
import { AppearanceUseCases } from '../application/appearance-use-cases';
export const WORKSPACE = new InjectionToken<WorkspaceUseCases>('Nexo workspace use cases');
export const APPEARANCE = new InjectionToken<AppearanceUseCases>('Nexo appearance use cases');
export const workspaceProviders = [
  HttpApi,
  BrowserFiles,
  BrowserAppearance,
  { provide: APPEARANCE, useFactory: () => new AppearanceUseCases(inject(BrowserAppearance)) },
  {
    provide: WORKSPACE,
    useFactory: () => new WorkspaceUseCases(inject(HttpApi), inject(BrowserFiles)),
  },
];
