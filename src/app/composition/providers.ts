import { InjectionToken, inject } from '@angular/core';
import { WorkspaceUseCases } from '../application/workspace-use-cases';
import { HttpApi } from '../infrastructure/http-api';
import { BrowserFiles } from '../infrastructure/browser-files';
import { BrowserPreferences } from '../infrastructure/browser-preferences';
import { BrowserAppearance } from '../infrastructure/browser-appearance';
import { DesktopSignInWindow } from '../infrastructure/desktop-sign-in-window';
import { AppearanceUseCases } from '../application/appearance-use-cases';
import { IntegrationUseCases } from '../application/integration-use-cases';
import { DataUseCases } from '../application/data-use-cases';
import { ProtocolUseCases } from '../application/protocol-use-cases';
import type { MongoUseCases } from '../application/mongo-use-cases';
import { ReportUseCases } from '../application/report-use-cases';
import { BrowserPrinter } from '../infrastructure/browser-printer';
export const WORKSPACE = new InjectionToken<WorkspaceUseCases>('Nexo workspace use cases');
export const APPEARANCE = new InjectionToken<AppearanceUseCases>('Nexo appearance use cases');
export const INTEGRATION = new InjectionToken<IntegrationUseCases>('Nexo integration use cases');
export const DATA = new InjectionToken<DataUseCases>('Nexo dataset and mock use cases');
export const PROTOCOLS = new InjectionToken<ProtocolUseCases>('Nexo protocol use cases');
export const REPORTS = new InjectionToken<ReportUseCases>('Nexo printable reports');
/** Loads the MongoDB use cases with the panel, so the first screen does not carry them. */
export type MongoLoader = () => Promise<MongoUseCases>;
export const MONGO = new InjectionToken<MongoLoader>('Nexo MongoDB connections');
export const workspaceProviders = [
  HttpApi,
  BrowserFiles,
  BrowserPreferences,
  BrowserAppearance,
  DesktopSignInWindow,
  BrowserPrinter,
  { provide: REPORTS, useFactory: () => new ReportUseCases(inject(BrowserPrinter)) },
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
    provide: MONGO,
    useFactory: (): MongoLoader => {
      const api = inject(HttpApi);
      const files = inject(BrowserFiles);
      let loaded: Promise<MongoUseCases> | undefined;
      return () =>
        (loaded ??= import('../application/mongo-use-cases').then(
          ({ MongoUseCases }) => new MongoUseCases(api, () => files.id()),
        ));
    },
  },
  {
    provide: WORKSPACE,
    useFactory: () =>
      new WorkspaceUseCases(
        inject(HttpApi),
        inject(BrowserFiles),
        inject(BrowserPreferences),
        inject(DesktopSignInWindow),
      ),
  },
];
