import type { EngineProfile } from '../../domain/db/engines';

/** The tabs of the connection form. */
export type EditorPage = 'main' | 'tls' | 'network' | 'startup' | 'properties' | 'general';

/** The label of each tab, as a message key. */
export const PAGE_LABELS: Readonly<Record<EditorPage, string>> = {
  main: 'Main',
  tls: 'TLS',
  network: 'Network',
  startup: 'Startup',
  properties: 'Driver settings',
  general: 'General',
};

/**
 * The tabs of the form of an engine: one without TLS has no TLS tab, and a database file
 * no network tab.
 */
export function editorPages(profile: EngineProfile): EditorPage[] {
  return (Object.keys(PAGE_LABELS) as EditorPage[]).filter((page) => {
    if (page === 'tls') return profile.tlsModes.length > 0;
    if (page === 'network') return !profile.file;
    return true;
  });
}
