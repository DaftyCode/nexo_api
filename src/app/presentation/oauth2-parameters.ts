import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, WritableSignal, input } from '@angular/core';
import { AuthDraft, withAuthValue } from '../domain/auth';

/** A custom parameter of the authorization, token or refresh request (Postman's format). */
interface Parameter {
  key: string;
  value: string;
  enabled: boolean;
  send_as: string;
}
export type ParameterList = 'authRequestParams' | 'tokenRequestParams' | 'refreshRequestParams';

/** Where each request can send its custom parameters, the first one by default. */
const placements = {
  authRequestParams: [
    ['request_url', 'Request URL'],
    ['request_header', 'Request Headers'],
  ],
  tokenRequestParams: [
    ['request_body', 'Request Body'],
    ['request_url', 'Request URL'],
    ['request_header', 'Request Headers'],
  ],
  refreshRequestParams: [
    ['request_body', 'Request Body'],
    ['request_url', 'Request URL'],
    ['request_header', 'Request Headers'],
  ],
} satisfies Record<ParameterList, [string, string][]>;

/** The custom parameters of one OAuth 2.0 request: authorization, token or refresh. */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-oauth2-parameters',
  styleUrl: './oauth2-editor.scss',
  templateUrl: './oauth2-parameters.html',
})
export class OAuth2Parameters {
  /** The authorization of the OAuth 2.0 editor, which the lists change in place. */
  readonly auth = input.required<WritableSignal<AuthDraft>>();
  readonly list = input.required<ParameterList>();
  readonly label = input.required<string>();
  protected readonly placements = placements;

  protected parameters(list: ParameterList): Parameter[] {
    const rows = this.auth()().values[list] as unknown;
    return Array.isArray(rows) ? (rows as Parameter[]) : [];
  }
  private set(list: ParameterList, value: unknown) {
    this.auth().update((auth) => withAuthValue(auth, list, value));
  }
  protected addParameter(list: ParameterList) {
    const send_as = placements[list][0][0];
    this.set(list, [...this.parameters(list), { key: '', value: '', enabled: true, send_as }]);
  }
  protected editParameter(
    list: ParameterList,
    index: number,
    field: keyof Parameter,
    event: Event,
  ) {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    const value = field === 'enabled' ? (target as HTMLInputElement).checked : target.value;
    this.set(
      list,
      this.parameters(list).map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    );
  }
  protected removeParameter(list: ParameterList, index: number) {
    const rows = this.parameters(list).filter((_, i) => i !== index);
    this.set(list, rows.length ? rows : undefined);
  }
}
