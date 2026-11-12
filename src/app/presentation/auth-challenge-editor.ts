import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { AuthTypeFields } from './auth-fields';

/** Authorizations that answer a server challenge: Digest and NTLM. */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-auth-challenge-editor',
  styleUrl: './auth-editor.scss',
  templateUrl: './auth-challenge-editor.html',
})
export class AuthChallengeEditor extends AuthTypeFields {
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
}
