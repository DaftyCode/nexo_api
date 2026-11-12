import { Directive, WritableSignal, input } from '@angular/core';
import { FieldTree } from '@angular/forms/signals';
import { AuthDraft, withAuthValue } from '../domain/auth';

/** Names Bruno and Insomnia give to Postman's keys; shown here and saved under Postman's. */
const aliases: Record<string, Record<string, readonly string[]>> = {
  oauth1: {
    token: ['accessToken', 'tokenKey'],
    tokenSecret: ['accessTokenSecret'],
    callback: ['callbackUrl'],
  },
  awsv4: { accessKey: ['accessKeyId'], secretKey: ['secretAccessKey'] },
  asap: {
    alg: ['algorithm'],
    iss: ['issuer'],
    sub: ['subject'],
    aud: ['audience'],
    kid: ['keyId'],
    claims: ['additionalClaims'],
  },
  hawk: {
    authId: ['id'],
    authKey: ['key'],
    extraData: ['ext'],
    delegation: ['dlg'],
    includePayloadHash: ['validatePayload'],
  },
};

/**
 * What the editors of an authorization share: the values of options that other clients
 * store under other names. Every editor writes to the same authorization, the one of the
 * form of the authorization editor, so none of them works on a copy.
 */
@Directive()
export abstract class AuthFields {
  /** The authorization being edited. */
  protected abstract authorization(): WritableSignal<AuthDraft>;

  /** A stored value of the type, for options without a dedicated form field. */
  protected value(key: string, fallback = ''): string {
    const auth = this.authorization()();
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
    this.setText(key, (event.target as HTMLInputElement | HTMLSelectElement).value);
  }
  /** Sets a value, and drops the names other clients give it so only one is kept. */
  protected setText(key: string, value: string) {
    this.authorization().update((auth) =>
      (aliases[auth.type]?.[key] ?? []).reduce(
        (next, alias) => withAuthValue(next, alias, undefined),
        withAuthValue(auth, key, value),
      ),
    );
  }
  protected toggle(key: string, event: Event) {
    const on = (event.target as HTMLInputElement).checked;
    // Stored only when on, so collections stay as other tools write them.
    this.authorization().update((auth) =>
      (aliases[auth.type]?.[key] ?? []).reduce(
        (next, alias) => withAuthValue(next, alias, undefined),
        withAuthValue(auth, key, on ? true : undefined),
      ),
    );
  }
}

/** The editor of some authorization types, inside the authorization editor. */
@Directive()
export abstract class AuthTypeFields extends AuthFields {
  /** The form of the authorization editor. */
  readonly fields = input.required<FieldTree<AuthDraft>>();
  protected authorization() {
    return this.fields()().value;
  }
  /** The authorization being edited, to read. */
  protected auth() {
    return this.fields()().value();
  }
}
