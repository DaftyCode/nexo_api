import { afterNextRender, DOCUMENT, effect, inject, Injectable, signal } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { LANGUAGE } from '../composition/language-providers';
import { Language, resolveLanguage } from '../domain/language';
import { NavigationEnd, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { Meta, Title } from '@angular/platform-browser';
@Injectable({ providedIn: 'root' })
export class LanguageState {
  private readonly cases = inject(LANGUAGE);
  private readonly translator = inject(TranslocoService);
  private readonly document = inject(DOCUMENT);
  private readonly router = inject(Router);
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);
  private readonly route = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );
  private readonly initialized = signal(false);
  readonly model = signal<{ language: Language }>({ language: 'en' });
  constructor() {
    afterNextRender(() => {
      this.model.set({ language: this.cases.current() });
      this.initialized.set(true);
    });
    effect((cleanup) => {
      const language = resolveLanguage(this.model().language);
      const route = this.route();
      this.translator.setActiveLang(language);
      this.document.documentElement.lang = language;
      const subscription = this.translator.load(language).subscribe(() => {
        const title = route.startsWith('/workspace')
          ? 'Workspace · Nexo API'
          : route.startsWith('/docs')
            ? 'Documentation · Nexo API'
            : 'Nexo API · Your APIs. Your workspace.';
        this.title.setTitle(this.translator.translate(title, {}, language));
        this.meta.updateTag({
          name: 'description',
          content: this.translator.translate<string>(
            'Build, test and organize APIs in your local desktop workspace or on your own server.',
            {},
            language,
          ),
        });
      });
      cleanup(() => subscription.unsubscribe());
      if (this.initialized()) this.cases.select(language);
    });
  }
}
