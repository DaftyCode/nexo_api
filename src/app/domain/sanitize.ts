import { ExecutionResponse, RequestDraft } from './models';

export const masked = '••••••';
const sensitiveHeader =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|private-token|x-access-token)$/i;
const placeholder = /^\s*\{\{[^{}]+\}\}\s*$/;

/** Literal values are hidden; `{{variable}}` references stay, since they hold no secret. */
function hide(value: string): string {
  return !value || placeholder.test(value) ? value : masked;
}

/**
 * Request saved in history: credentials and credential headers are never persisted, and
 * chosen files keep only their names.
 */
export function historyRequest(request: RequestDraft): RequestDraft {
  const { bodyFile } = request;
  return {
    ...request,
    form: request.form.map(({ files: _files, ...row }) => row),
    ...(bodyFile ? { bodyFile: { src: bodyFile.src } } : {}),
    headers: request.headers.map((row) =>
      sensitiveHeader.test(row.key) ? { ...row, value: hide(row.value) } : row,
    ),
    auth: {
      ...request.auth,
      token: hide(request.auth.token),
      password: hide(request.auth.password),
      value: request.auth.type === 'apikey' ? hide(request.auth.value) : request.auth.value,
      values: Object.fromEntries(
        Object.entries(request.auth.values).map(([key, value]) => [key, hide(String(value))]),
      ),
      parameters: '{}',
    },
    transport: '{}',
  };
}

/** Response saved in history: credential headers removed and large bodies truncated. */
export function historyResponse(
  response: ExecutionResponse,
  maxBody = 256 * 1024,
): ExecutionResponse {
  const { variables: _variables, request: _request, ...rest } = response;
  return {
    ...rest,
    headers: (rest.headers ?? []).map((row) =>
      sensitiveHeader.test(row.key) ? { ...row, value: masked } : row,
    ),
    body: (rest.body ?? '').length > maxBody ? rest.body.slice(0, maxBody) : (rest.body ?? ''),
    truncated: rest.truncated || (rest.body ?? '').length > maxBody,
  };
}

const secretAuthKeys = new Set([
  'token',
  'password',
  'value',
  'accessToken',
  'clientSecret',
  'refreshToken',
  'code_verifier',
  'consumerSecret',
  'tokenSecret',
  'privateKey',
  'accessTokenSecret',
  'secretKey',
  'secretAccessKey',
  'sessionToken',
  'authKey',
  'secret',
]);
/**
 * Collection prepared for a shared Git repository: literal credentials in auth helpers and
 * client certificates are removed; variable references are kept.
 */
export function exportableCollection(value: unknown): unknown {
  const visit = (node: unknown, key = ''): unknown => {
    if (Array.isArray(node)) {
      if (
        [
          'basic',
          'bearer',
          'apikey',
          'oauth2',
          'digest',
          'oauth1',
          'awsv4',
          'hawk',
          'ntlm',
          'jwt',
          'asap',
          'edgegrid',
          'wsse',
        ].includes(key)
      )
        return node.map((row) =>
          row &&
          typeof row === 'object' &&
          (secretAuthKeys.has(String((row as { key?: unknown }).key)) ||
            // Insomnia calls the Hawk key `key`, which for an API key is only the header name.
            (key === 'hawk' && (row as { key?: unknown }).key === 'key'))
            ? { ...row, value: hide(String((row as { value?: unknown }).value ?? '')) }
            : row,
        );
      return node.map((item) => visit(item));
    }
    if (!node || typeof node !== 'object') return node;
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).flatMap(([name, item]) => {
        if (name === 'nexoTransport') return [];
        return [[name, visit(item, name)]];
      }),
    );
  };
  return visit(value);
}
