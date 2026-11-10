import { Injectable } from '@angular/core';
import { Translation, TranslocoLoader } from '@jsverse/transloco';
import { from, map } from 'rxjs';

/**
 * The translations ship inside the app, never from the API: one chunk per language, loaded
 * when the language is first used, so the initial bundle does not grow with every message.
 */
@Injectable()
export class EmbeddedTranslations implements TranslocoLoader {
  getTranslation(language: string) {
    const chunk = language === 'es' ? import('./i18n/es.json') : import('./i18n/en.json');
    return from(chunk).pipe(map((module) => module.default as Translation));
  }
}
