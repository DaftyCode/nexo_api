import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { AuthDraft, Inheritance, authDetails, emptyAuth, withAuthValue } from '../domain/auth';
import { OAuth2Editor } from './oauth2-editor';

/** Names Bruno and Insomnia give to Postman's keys; shown here and saved under Postman's. */
const aliases: Record<string, Record<string, readonly string[]>> = {
  oauth1: {
    token: ['accessToken', 'tokenKey'],
    tokenSecret: ['accessTokenSecret'],
    callback: ['callbackUrl'],
  },
  awsv4: { accessKey: ['accessKeyId'], secretKey: ['secretAccessKey'] },
  hawk: {
    authId: ['id'],
    authKey: ['key'],
    extraData: ['ext'],
    delegation: ['dlg'],
    includePayloadHash: ['validatePayload'],
  },
};

const labels: Record<string, string> = {
  noauth: 'No auth',
  bearer: 'Bearer token',
  basic: 'Basic auth',
  apikey: 'API key',
  digest: 'Digest auth',
  oauth1: 'OAuth 1.0',
  oauth2: 'OAuth 2.0',
  awsv4: 'AWS Signature',
  ntlm: 'NTLM Authentication',
  hawk: 'Hawk Authentication',
};

/**
 * Authorization of a request, folder or collection. Requests and folders can inherit it from
 * the folder or collection above them, which is then shown with a link to edit it there.
 */
@Component({
  imports: [TranslocoPipe, FormField, OAuth2Editor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-auth-editor',
  styleUrl: './auth-editor.scss',
  templateUrl: './auth-editor.html',
})
export class AuthEditor {
  readonly auth = model<AuthDraft>(emptyAuth());
  /** Offers "Inherit from parent"; a collection has no parent to inherit from. */
  readonly inheritable = input(false);
  /** What inheriting gives; `undefined` when the item is not saved in a collection. */
  readonly inheritance = input<Inheritance | undefined>(undefined);
  /** Opens the folder or collection the authorization is inherited from. */
  readonly editInherited = output<void>();
  /** OAuth 2.0: a token request is running. */
  readonly tokenBusy = input(false);
  /** OAuth 2.0: "Get new access token" (`false`) or "Refresh" (`true`). */
  readonly tokenRequested = output<boolean>();
  protected readonly fields = form(this.auth);
  /** A stored type this editor does not list, shown so that it is neither hidden nor lost. */
  protected readonly unknownType = computed(() => {
    const type = this.auth().type;
    return type === 'inherit' || type in labels ? undefined : type;
  });
  protected readonly details = authDetails;
  /** Postman's advanced Digest fields, generated when left blank. */
  protected readonly digestFields = [
    { key: 'realm', label: 'Realm', placeholder: 'testrealm@example.com' },
    { key: 'nonce', label: 'Nonce', placeholder: 'Nonce' },
    { key: 'qop', label: 'qop', placeholder: 'auth, auth-int' },
    { key: 'nonceCount', label: 'Nonce Count', placeholder: '00000001' },
    { key: 'clientNonce', label: 'Client Nonce', placeholder: '0a4f113b' },
    { key: 'opaque', label: 'Opaque', placeholder: 'Opaque' },
  ];
  protected readonly digestAlgorithms = [
    'MD5',
    'MD5-sess',
    'SHA-256',
    'SHA-256-sess',
    'SHA-512-256',
    'SHA-512-256-sess',
  ];
  /** Postman's OAuth 1.0 signature methods; HMAC-SHA1 when none is stored. */
  protected readonly oauth1Methods = [
    'HMAC-SHA1',
    'HMAC-SHA256',
    'HMAC-SHA512',
    'RSA-SHA1',
    'RSA-SHA256',
    'RSA-SHA512',
    'PLAINTEXT',
  ];
  /** Postman's advanced OAuth 1.0 fields; timestamp and nonce are generated when blank. */
  protected readonly oauth1Fields = [
    { key: 'callback', label: 'Callback URL', placeholder: 'https://example.com/callback' },
    { key: 'verifier', label: 'Verifier', placeholder: 'Verifier' },
    { key: 'timestamp', label: 'Timestamp', placeholder: 'Timestamp' },
    { key: 'nonce', label: 'Nonce', placeholder: 'Nonce' },
    { key: 'version', label: 'Version', placeholder: '1.0' },
    { key: 'realm', label: 'Realm', placeholder: 'testrealm@example.com' },
  ];
  /** Postman's advanced Hawk fields; nonce and timestamp are generated when blank. */
  protected readonly hawkFields = [
    { key: 'user', label: 'User', placeholder: 'User' },
    { key: 'nonce', label: 'Nonce', placeholder: 'Nonce' },
    { key: 'extraData', label: 'ext', placeholder: 'Extra data' },
    { key: 'app', label: 'app', placeholder: 'Application ID' },
    { key: 'delegation', label: 'dlg', placeholder: 'Delegated by' },
    { key: 'timestamp', label: 'Timestamp', placeholder: 'Timestamp' },
  ];
  /** Where OAuth 1.0 puts its parameters: Postman's `addParamsToHeader` or Bruno's `placement`. */
  protected oauth1Placement(): 'header' | 'body' {
    return this.checked('addParamsToHeader') || this.value('placement') === 'header'
      ? 'header'
      : 'body';
  }
  protected placeOAuth1(event: Event) {
    const header = (event.target as HTMLSelectElement).value === 'header';
    this.auth.update((auth) =>
      withAuthValue(withAuthValue(auth, 'placement', undefined), 'addParamsToHeader', header),
    );
  }
  protected placeAws(event: Event) {
    const query = (event.target as HTMLSelectElement).value === 'query';
    this.auth.update((auth) => withAuthValue(auth, 'addAuthDataToQuery', query));
  }
  protected encodeOAuth1Header(event: Event) {
    const encode = (event.target as HTMLInputElement).checked;
    this.auth.update((auth) =>
      withAuthValue(auth, 'disableHeaderEncoding', encode ? undefined : true),
    );
  }
  protected label(type: string): string | undefined {
    return labels[type];
  }
  /** A stored value of the type, for options without a dedicated form field. */
  protected value(key: string, fallback = ''): string {
    const auth = this.auth();
    // An empty value is kept (Insomnia's empty Bearer prefix); a blank key falls back to its
    // name in Bruno or Insomnia.
    const stored = [key, ...(aliases[auth.type]?.[key] ?? [])]
      .map((name) => auth.values[name] as unknown)
      .filter((value) => value !== undefined && value !== null);
    const value = stored.find((item) => item !== '') ?? stored[0];
    return value === undefined ? fallback : String(value);
  }
  protected checked(key: string): boolean {
    const value = this.value(key);
    return value === 'true';
  }
  protected text(key: string, event: Event) {
    const value = (event.target as HTMLInputElement | HTMLSelectElement).value;
    this.auth.update((auth) =>
      (aliases[auth.type]?.[key] ?? []).reduce(
        (next, alias) => withAuthValue(next, alias, undefined),
        withAuthValue(auth, key, value),
      ),
    );
  }
  protected toggle(key: string, event: Event) {
    const on = (event.target as HTMLInputElement).checked;
    // Stored only when on, so collections stay as other tools write them.
    this.auth.update((auth) =>
      (aliases[auth.type]?.[key] ?? []).reduce(
        (next, alias) => withAuthValue(next, alias, undefined),
        withAuthValue(auth, key, on ? true : undefined),
      ),
    );
  }
}
