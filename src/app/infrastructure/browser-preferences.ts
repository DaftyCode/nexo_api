import { DOCUMENT, inject, Injectable } from '@angular/core';
import { PreferencePort } from '../application/ports';

const prefix = 'nexo.preference.';

/** Stores preferences in `localStorage`; unavailable storage (SSR, privacy modes) is ignored. */
@Injectable()
export class BrowserPreferences implements PreferencePort {
  private readonly document = inject(DOCUMENT);

  read(key: string): string | undefined {
    try {
      return this.document.defaultView?.localStorage.getItem(prefix + key) ?? undefined;
    } catch {
      return undefined;
    }
  }

  write(key: string, value: string): void {
    try {
      const storage = this.document.defaultView?.localStorage;
      if (value) storage?.setItem(prefix + key, value);
      else storage?.removeItem(prefix + key);
    } catch {
      // Preferences are a convenience; a blocked storage must not break the workspace.
    }
  }
}
