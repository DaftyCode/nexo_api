import { DOCUMENT, inject } from '@angular/core';
import { ResolveFn } from '@angular/router';

let loading: Promise<boolean> | undefined;

/**
 * The visual templates are a separate stylesheet, loaded once. Every page waits for it: the
 * workspace for its layouts, and the website (home and documentation) for the colours of the
 * template chosen in the app. Waiting avoids a flash of unstyled content.
 */
export const templateStyles: ResolveFn<boolean> = () => {
  const document = inject(DOCUMENT);
  loading ??= new Promise<boolean>((resolve) => {
    const link = document.createElement('link');
    link.id = 'workspace-templates';
    link.rel = 'stylesheet';
    link.href = 'workspace-templates.css';
    link.onload = () => resolve(true);
    // A missing stylesheet must not block the workspace.
    link.onerror = () => resolve(false);
    // Same cascade position as before the split: the templates were emitted at the top of
    // the global stylesheet, so base and component rules still win over them.
    const global = document.head.querySelector('link[rel="stylesheet"][href*="styles"]');
    if (global) global.before(link);
    else document.head.prepend(link);
  });
  return loading;
};
