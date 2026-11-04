import { DOCUMENT, inject, Injectable } from '@angular/core';
import { LanguagePreferencesPort } from '../application/language-use-cases';
import { Language } from '../domain/language';
@Injectable()
export class BrowserLanguage implements LanguagePreferencesPort {
  private readonly document = inject(DOCUMENT);
  load(): unknown {
    try {
      return this.document.defaultView?.localStorage.getItem('nexo.language');
    } catch {
      return undefined;
    }
  }
  save(language: Language): void {
    try {
      this.document.defaultView?.localStorage.setItem('nexo.language', language);
    } catch {
      /* Storage restrictions must not prevent language changes. */
    }
  }
}
