import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { AuthTypeFields } from './auth-fields';
import { CodeEditor } from './code-editor';

/** Authorizations that send a token signed for each request: JWT Bearer and Atlassian ASAP. */
@Component({
  imports: [TranslocoPipe, CodeEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-auth-token-editor',
  styleUrl: './auth-editor.scss',
  templateUrl: './auth-token-editor.html',
})
export class AuthTokenEditor extends AuthTypeFields {
  /** The algorithms of Postman's JWT Bearer. */
  protected readonly jwtAlgorithms = [
    'HS256',
    'HS384',
    'HS512',
    'RS256',
    'RS384',
    'RS512',
    'PS256',
    'PS384',
    'PS512',
    'ES256',
    'ES384',
    'ES512',
  ];
  /** ASAP signs with RSA or ECDSA keys; it has no HMAC algorithms. */
  protected readonly asapAlgorithms = this.jwtAlgorithms.filter((name) => !name.startsWith('HS'));
  /** Postman's ASAP claims; the subject is the issuer when left blank. */
  protected readonly asapFields = [
    { key: 'iss', label: 'Issuer', placeholder: 'micros/my-service' },
    { key: 'sub', label: 'Subject', placeholder: 'micros/my-service' },
    { key: 'aud', label: 'Audience', placeholder: 'jira' },
    { key: 'kid', label: 'Key ID', placeholder: 'micros/my-service/key-1' },
  ];
  protected readonly asapClaimsExample = '{ "scope": "read" }';
  protected readonly jwtPayloadExample = '{ "sub": "{{user}}", "iat": 1700000000 }';
  protected readonly jwtHeaderExample = '{ "typ": "JWT", "kid": "key-1" }';
}
