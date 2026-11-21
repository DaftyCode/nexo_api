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
import type { DatabaseUseCases } from '../application/database-use-cases';
import { ReportUseCases } from '../application/report-use-cases';
import { ModulesUseCases } from '../application/modules-use-cases';
import { BrowserPrinter } from '../infrastructure/browser-printer';
import { BrowserPageExit } from '../infrastructure/browser-page-exit';
import { BrowserNotifications } from '../infrastructure/browser-notifications';
import type { DatabaseFilesPort, NativeFilesPort, TransferFilesPort } from '../application/ports';
import { transferFiles } from '../infrastructure/transfer-files';
import { databaseFiles } from '../infrastructure/database-files';
import { nativeFiles } from '../infrastructure/native-files';
export const WORKSPACE = new InjectionToken<WorkspaceUseCases>('Nexo workspace use cases');
export const APPEARANCE = new InjectionToken<AppearanceUseCases>('Nexo appearance use cases');
export const INTEGRATION = new InjectionToken<IntegrationUseCases>('Nexo integration use cases');
export const DATA = new InjectionToken<DataUseCases>('Nexo dataset and mock use cases');
export const PROTOCOLS = new InjectionToken<ProtocolUseCases>('Nexo protocol use cases');
export const REPORTS = new InjectionToken<ReportUseCases>('Nexo printable reports');
/** The database modules, downloaded when they are needed. */
export const MODULES = new InjectionToken<ModulesUseCases>('Nexo database modules');
/** Loads the MongoDB use cases with the panel, so the first screen does not carry them. */
export type MongoLoader = () => Promise<MongoUseCases>;
export const MONGO = new InjectionToken<MongoLoader>('Nexo MongoDB connections');
/** Loads the database section's use cases with its panel. */
export type DatabaseLoader = () => Promise<DatabaseUseCases>;
export const DATABASES = new InjectionToken<DatabaseLoader>('Nexo database connections');
/** Files of MongoDB imports and exports: chosen in the browser, or in the desktop dialogs. */
export const TRANSFER_FILES = new InjectionToken<TransferFilesPort>('Nexo transfer files');
/** The file of a SQLite connection: chosen in the desktop dialog, typed in the web version. */
export const DATABASE_FILES = new InjectionToken<DatabaseFilesPort>('Nexo database files');
/** The dialogs of the local client tools: the desktop app only. */
export const NATIVE_FILES = new InjectionToken<NativeFilesPort>('Nexo local client files');
export const workspaceProviders = [
  HttpApi,
  BrowserFiles,
  BrowserPreferences,
  BrowserAppearance,
  DesktopSignInWindow,
  BrowserPrinter,
  BrowserPageExit,
  BrowserNotifications,
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
    provide: MODULES,
    useFactory: () =>
      new ModulesUseCases(inject(HttpApi), inject(BrowserFiles), inject(BrowserPreferences)),
  },
  { provide: TRANSFER_FILES, useFactory: transferFiles },
  { provide: DATABASE_FILES, useFactory: databaseFiles },
  { provide: NATIVE_FILES, useFactory: nativeFiles },
  {
    provide: MONGO,
    useFactory: (): MongoLoader => {
      const api = inject(HttpApi);
      const files = inject(BrowserFiles);
      const preferences = inject(BrowserPreferences);
      let loaded: Promise<MongoUseCases> | undefined;
      return () =>
        (loaded ??= import('../application/mongo-use-cases').then(
          ({ MongoUseCases }) => new MongoUseCases(api, () => files.id(), preferences),
        ));
    },
  },
  {
    provide: DATABASES,
    useFactory: (): DatabaseLoader => {
      const api = inject(HttpApi);
      const preferences = inject(BrowserPreferences);
      // Leaving the page closes the sessions it opened on the databases.
      const exit = inject(BrowserPageExit);
      let loaded: Promise<DatabaseUseCases> | undefined;
      return () =>
        (loaded ??= import('../application/database-use-cases').then(
          ({ DatabaseUseCases }) => new DatabaseUseCases(api, preferences, exit),
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
        inject(BrowserNotifications),
      ),
  },
];
