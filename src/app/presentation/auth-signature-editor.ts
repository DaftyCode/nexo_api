import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { withAuthValue } from '../domain/auth';
import { AuthTypeFields } from './auth-fields';
import { CodeEditor } from './code-editor';

/** Authorizations that sign each request: OAuth 1.0, AWS Signature, Akamai EdgeGrid and Hawk. */
@Component({
  imports: [TranslocoPipe, CodeEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-auth-signature-editor',
  styleUrl: './auth-editor.scss',
  templateUrl: './auth-signature-editor.html',
})
export class AuthSignatureEditor extends AuthTypeFields {
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
  /** Postman's advanced EdgeGrid fields (and Bruno's maximum body size). */
  protected readonly edgegridFields = [
    { key: 'nonce', label: 'Nonce', placeholder: 'Nonce' },
    { key: 'timestamp', label: 'Timestamp', placeholder: 'Timestamp' },
    {
      key: 'baseURL',
      label: 'Base URL',
      placeholder: 'https://akab-xxxx.luna.akamaiapis.net',
    },
    { key: 'headersToSign', label: 'Headers to Sign', placeholder: 'x-api-key, x-api-version' },
    { key: 'maxBodySize', label: 'Max Body Size', placeholder: '131072' },
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
    this.authorization().update((auth) =>
      withAuthValue(withAuthValue(auth, 'placement', undefined), 'addParamsToHeader', header),
    );
  }
  protected placeAws(event: Event) {
    const query = (event.target as HTMLSelectElement).value === 'query';
    this.authorization().update((auth) => withAuthValue(auth, 'addAuthDataToQuery', query));
  }
  protected encodeOAuth1Header(event: Event) {
    const encode = (event.target as HTMLInputElement).checked;
    this.authorization().update((auth) =>
      withAuthValue(auth, 'disableHeaderEncoding', encode ? undefined : true),
    );
  }
}
