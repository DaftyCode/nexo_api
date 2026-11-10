import { Injectable } from '@angular/core';
import { Translation, TranslocoLoader } from '@jsverse/transloco';
import { of } from 'rxjs';
import en from '../infrastructure/i18n/en.json';
import es from '../infrastructure/i18n/es.json';

/** Both languages at once, so tests render translated text without waiting for a chunk. */
@Injectable()
export class TestTranslations implements TranslocoLoader {
  getTranslation(language: string) {
    return of<Translation>(language === 'es' ? es : en);
  }
}
