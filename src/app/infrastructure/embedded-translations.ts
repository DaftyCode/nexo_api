import { Injectable } from '@angular/core';
import { Translation, TranslocoLoader } from '@jsverse/transloco';
import { of } from 'rxjs';
import en from './i18n/en.json';
import es from './i18n/es.json';
export const translations = { en, es };
@Injectable()
export class EmbeddedTranslations implements TranslocoLoader {
  getTranslation(language: string) {
    return of<Translation>(language === 'es' ? es : en);
  }
}
