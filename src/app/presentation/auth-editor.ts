import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { AuthDraft, Inheritance, authDetails, emptyAuth } from '../domain/auth';
import { AuthChallengeEditor } from './auth-challenge-editor';
import { AuthFields } from './auth-fields';
import { AuthSignatureEditor } from './auth-signature-editor';
import { AuthTokenEditor } from './auth-token-editor';
import { CodeEditor } from './code-editor';
import { OAuth2Editor } from './oauth2-editor';

const labels: Record<string, string> = {
  noauth: 'No auth',
  bearer: 'Bearer token',
  basic: 'Basic auth',
  apikey: 'API key',
  digest: 'Digest auth',
  oauth1: 'OAuth 1.0',
  oauth2: 'OAuth 2.0',
  jwt: 'JWT Bearer',
  asap: 'ASAP (Atlassian)',
  awsv4: 'AWS Signature',
  ntlm: 'NTLM Authentication',
  edgegrid: 'Akamai EdgeGrid',
  wsse: 'WSSE Auth',
  netrc: 'Netrc File',
  hawk: 'Hawk Authentication',
};

/**
 * Authorization of a request, folder or collection. Requests and folders can inherit it from
 * the folder or collection above them, which is then shown with a link to edit it there.
 */
@Component({
  imports: [
    TranslocoPipe,
    FormField,
    OAuth2Editor,
    AuthChallengeEditor,
    AuthSignatureEditor,
    AuthTokenEditor,
    CodeEditor,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-auth-editor',
  styleUrl: './auth-editor.scss',
  templateUrl: './auth-editor.html',
})
export class AuthEditor extends AuthFields {
  readonly auth = model<AuthDraft>(emptyAuth());
  protected readonly fields = form(this.auth);
  protected authorization() {
    return this.auth;
  }
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
  /** A stored type this editor does not list, shown so that it is neither hidden nor lost. */
  protected readonly unknownType = computed(() => {
    const type = this.auth().type;
    return type === 'inherit' || type in labels ? undefined : type;
  });
  protected readonly details = authDetails;
  protected label(type: string): string | undefined {
    return labels[type];
  }
}
