/**
 * Database modules: each database engine is a driver Nexo downloads when it is first needed,
 * so the computer keeps only the ones in use. The backend answers these shapes.
 */
export type ModuleState = 'available' | 'installed' | 'outdated' | 'development';

export interface ModuleSummary {
  id: string;
  name: string;
  description: string;
  version: string;
  state: ModuleState;
  /** Bytes downloaded to install it. */
  downloadSize: number;
  /** Bytes it takes once installed. */
  size: number;
  licenses: readonly string[];
  /** Where it is downloaded from. */
  source: string;
  /** A copy came with Nexo: installing it needs no network. */
  bundled: boolean;
}

export type InstallState = 'idle' | 'downloading' | 'verifying' | 'installed' | 'failed';

export interface InstallProgress {
  id: string;
  state: InstallState;
  received: number;
  total: number;
  error?: string;
}

/** Whether a module's driver can run now. */
export function isReady(module: ModuleSummary): boolean {
  return module.state === 'installed' || module.state === 'development';
}

/** Whether an installation is still going. */
export function isInstalling(progress: InstallProgress | undefined): boolean {
  return progress?.state === 'downloading' || progress?.state === 'verifying';
}

/** How much of a download arrived, from 0 to 100. */
export function percent(progress: InstallProgress): number {
  if (progress.state === 'verifying' || progress.state === 'installed') return 100;
  if (!progress.total) return 0;
  return Math.min(100, Math.round((progress.received / progress.total) * 100));
}

/** The host a module downloads from, to name it to the person. */
export function sourceHost(module: ModuleSummary): string {
  try {
    return new URL(module.source).host;
  } catch {
    return '';
  }
}

/** The connections of a workspace that use a module's driver. */
export function connectionsOf(
  id: string,
  documents: readonly { kind: string; value?: unknown }[],
): number {
  return documents.filter(
    (document) =>
      document.kind === 'connection' && (document.value as { driver?: string })?.driver === id,
  ).length;
}
