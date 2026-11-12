import { TranslocoPipe } from '@jsverse/transloco';
import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import {
  AuthDraft,
  OAuth2Field,
  autoFetches,
  autoRefreshes,
  emptyAuth,
  oauth2Grant,
  oauth2Shows,
  oauth2UsesBrowser,
  selectedToken,
  withAuthValue,
  withCustomToken,
  withOAuth2Token,
} from '../domain/auth';
import { WorkspaceState } from './workspace-state';

import { OAuth2Parameters, ParameterList } from './oauth2-parameters';

/**
 * OAuth 2.0 settings laid out as in Postman: the current token, "Configure New Token" with
 * the fields of each grant type, and the advanced options, plus Insomnia's audience,
 * resource and origin. Values are stored under Postman's keys.
 */
@Component({
  imports: [TranslocoPipe, DatePipe, OAuth2Parameters],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-oauth2-editor',
  styleUrl: './oauth2-editor.scss',
  templateUrl: './oauth2-editor.html',
})
export class OAuth2Editor {
  readonly auth = model<AuthDraft>(emptyAuth('oauth2'));
  /** Disables the token buttons while a token request runs. */
  readonly busy = input(false);
  /** "Get new access token" (`false`) or "Refresh" (`true`). */
  readonly tokenRequested = output<boolean>();
  protected readonly showToken = signal(false);
  /** Nexo's callback page, the counterpart of Postman's browser callback. */
  protected readonly relayUrl = 'https://daftycode.github.io/nexo_api/oauth/callback';
  protected readonly state = inject(WorkspaceState);
  protected readonly grant = computed(() => oauth2Grant(this.auth()));
  protected readonly usesBrowser = computed(() => oauth2UsesBrowser(this.auth()));
  /** The stored token in use ("Available Tokens"), or none for a custom token. */
  protected readonly selected = computed(() =>
    selectedToken(this.auth(), this.state.oauth2Tokens()),
  );
  protected readonly autoRefresh = computed(() => autoRefreshes(this.auth()));
  protected readonly autoFetch = computed(() => autoFetches(this.auth()));
  constructor() {
    void this.state.loadOAuth2Tokens();
  }
  protected now() {
    return Date.now();
  }
  protected choose(event: Event) {
    const id = (event.target as HTMLSelectElement).value;
    const token = this.state.oauth2Tokens().find((entry) => entry.id === id);
    this.auth.update((auth) => (token ? withOAuth2Token(auth, token) : withCustomToken(auth, '')));
  }
  protected custom(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.auth.update((auth) => withCustomToken(auth, value));
  }
  protected source(event: Event) {
    const source = (event.target as HTMLSelectElement).value;
    const token = this.selected();
    this.auth.update((auth) => {
      const next = withAuthValue(auth, 'tokenSource', source);
      return token ? withOAuth2Token(next, token) : next;
    });
  }
  protected toggleAutoFetch(event: Event) {
    // Bruno's option; stored only when on, so Postman collections stay as they are.
    this.set('autoFetchToken', (event.target as HTMLInputElement).checked ? true : undefined);
  }
  protected toggleAutoRefresh(event: Event) {
    // Stored only when turned off, so collections keep Postman's default.
    this.set('autoRefreshToken', (event.target as HTMLInputElement).checked ? undefined : false);
  }
  protected readonly lists: { id: ParameterList; label: string }[] = [
    { id: 'authRequestParams', label: 'Auth Request' },
    { id: 'tokenRequestParams', label: 'Token Request' },
    { id: 'refreshRequestParams', label: 'Refresh Request' },
  ];

  protected shows(field: OAuth2Field) {
    return oauth2Shows(this.auth(), field);
  }
  protected value(key: string, fallback = ''): string {
    const value = this.auth().values[key];
    return value === undefined || value === null ? fallback : String(value);
  }
  protected checked(key: string): boolean {
    const value = this.auth().values[key] as unknown;
    return value === true || value === 'true';
  }
  protected set(key: string, value: unknown) {
    this.auth.update((auth) => withAuthValue(auth, key, value));
  }
  protected text(key: string, event: Event) {
    this.set(key, (event.target as HTMLInputElement | HTMLSelectElement).value);
  }
  protected toggle(key: string, event: Event) {
    this.set(key, (event.target as HTMLInputElement).checked);
  }
}
