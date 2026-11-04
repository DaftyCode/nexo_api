import { inject, InjectionToken } from '@angular/core';
import { provideTransloco, TRANSLOCO_MISSING_HANDLER } from '@jsverse/transloco';
import { registerLocaleData } from '@angular/common';
import spanishLocale from '@angular/common/locales/es';
import { LanguageUseCases } from '../application/language-use-cases';
import { BrowserLanguage } from '../infrastructure/browser-language';
import { EmbeddedTranslations } from '../infrastructure/embedded-translations';
export const LANGUAGE = new InjectionToken<LanguageUseCases>('Nexo language preferences');
export function languageProviders() {
  registerLocaleData(spanishLocale);
  return [
    BrowserLanguage,
    { provide: LANGUAGE, useFactory: () => new LanguageUseCases(inject(BrowserLanguage)) },
    provideTransloco({
      config: {
        availableLangs: ['en', 'es'],
        defaultLang: 'en',
        fallbackLang: 'en',
        reRenderOnLangChange: true,
        prodMode: true,
        flatten: { aot: true },
      },
      loader: EmbeddedTranslations,
    }),
    { provide: TRANSLOCO_MISSING_HANDLER, useValue: { handle: (message: string) => message } },
  ];
}
