import { Agent, ProxyAgent, fetch, FormData } from 'undici';
import { randomBytes, createHash } from 'node:crypto';
import { validateUrl } from '../domain/collection.mjs';

function authValues(auth = {}) {
  const source = auth[auth.type];
  return {
    ...auth,
    ...(Array.isArray(source)
      ? Object.fromEntries(source.map(({ key, value }) => [key, value]))
      : source),
  };
}
function digestHeader(challenge, auth, url, method) {
  const parts = Object.fromEntries(
    [...challenge.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map((m) => [m[1], m[2] ?? m[3]]),
  );
  const algorithm = (parts.algorithm ?? 'MD5').toUpperCase();
  if (!['MD5', 'MD5-SESS', 'SHA-256', 'SHA-256-SESS'].includes(algorithm))
    throw new Error('Unsupported digest algorithm');
  const hash = (value) =>
    createHash(algorithm.startsWith('SHA-256') ? 'sha256' : 'md5')
      .update(value)
      .digest('hex');
  const uri = new URL(url).pathname + new URL(url).search,
    nc = '00000001',
    cnonce = randomBytes(12).toString('hex');
  let ha1 = hash(`${auth.username ?? ''}:${parts.realm}:${auth.password ?? ''}`);
  if (algorithm.endsWith('-SESS')) ha1 = hash(`${ha1}:${parts.nonce}:${cnonce}`);
  const qop = parts.qop
    ?.split(',')
    .map((s) => s.trim())
    .includes('auth')
    ? 'auth'
    : undefined;
  const response = hash(
    qop
      ? `${ha1}:${parts.nonce}:${nc}:${cnonce}:auth:${hash(`${method}:${uri}`)}`
      : `${ha1}:${parts.nonce}:${hash(`${method}:${uri}`)}`,
  );
  return `Digest username="${String(auth.username ?? '').replaceAll('"', '')}", realm="${parts.realm}", nonce="${parts.nonce}", uri="${uri}", response="${response}", algorithm=${algorithm}${qop ? `, qop=auth, nc=${nc}, cnonce="${cnonce}"` : ''}${parts.opaque ? `, opaque="${parts.opaque}"` : ''}`;
}
export function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (input?.raw) return input.raw;
  const host = Array.isArray(input?.host) ? input.host.join('.') : (input?.host ?? '');
  const path = Array.isArray(input?.path) ? input.path.join('/') : (input?.path ?? '');
  const query = (input?.query ?? [])
    .filter((q) => !q.disabled)
    .map((q) => `${encodeURIComponent(q.key)}=${encodeURIComponent(q.value ?? '')}`)
    .join('&');
  return `${input?.protocol ?? 'https'}://${host}${input?.port ? `:${input.port}` : ''}/${path}${query ? `?${query}` : ''}`;
}
export class HttpTransport {
  #options;
  #jar;
  #agent;
  constructor(options, jar) {
    this.#options = options;
    this.#jar = jar;
    const config =
      typeof options.request?.transport === 'string' && options.request.transport
        ? JSON.parse(options.request.transport)
        : (options.transport ?? {});
    const tls = {
      rejectUnauthorized: options.strictSSL !== false,
      ...(config.caPem ? { ca: config.caPem } : {}),
      ...(config.clientTls
        ? {
            cert: config.clientTls.certPem,
            key: config.clientTls.keyPem,
            passphrase: config.clientTls.passphrase,
          }
        : {}),
    };
    const proxy = config.proxy ?? options.proxy;
    this.#agent =
      proxy && proxy.disabled !== true
        ? new ProxyAgent({
            uri: proxy.uri ?? `${proxy.protocol ?? 'http'}://${proxy.host}:${proxy.port}`,
            ...(proxy.username
              ? {
                  token: `Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64')}`,
                }
              : {}),
            requestTls: tls,
            proxyTls: { rejectUnauthorized: options.strictSSL !== false },
          })
        : new Agent({ connect: tls });
  }
  async request(input) {
    const started = Date.now();
    let url = requestUrl(input.url);
    validateUrl(url);
    let method = (input.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(
      (Array.isArray(input.header)
        ? input.header
        : Object.entries(input.header ?? {}).map(([key, value]) => ({ key, value }))
      )
        .filter((h) => !h.disabled && h.key)
        .map((h) => [h.key.toLowerCase(), String(h.value ?? '')]),
    );
    const auth = authValues(input.auth);
    if (auth.type === 'basic')
      headers.authorization = `Basic ${Buffer.from(`${auth.username ?? ''}:${auth.password ?? ''}`).toString('base64')}`;
    else if (['bearer', 'oauth2'].includes(auth.type))
      headers.authorization = `Bearer ${auth.token ?? auth.accessToken ?? ''}`;
    else if (auth.type === 'apikey') {
      if (auth.in === 'query') {
        const target = new URL(url);
        target.searchParams.append(auth.key, auth.value);
        url = target.href;
      } else headers[String(auth.key).toLowerCase()] = String(auth.value ?? '');
    } else if (auth.type && !['noauth', 'inherit', 'digest'].includes(auth.type))
      throw new Error(`Unsupported authentication helper: ${auth.type}`);
    let body;
    if (!['GET', 'HEAD'].includes(method)) {
      if (input.body?.mode === 'urlencoded') {
        body = new URLSearchParams(
          (input.body.urlencoded ?? [])
            .filter((r) => !r.disabled)
            .map((r) => [r.key, r.value ?? '']),
        ).toString();
        headers['content-type'] ??= 'application/x-www-form-urlencoded';
      } else if (input.body?.mode === 'formdata') {
        body = new FormData();
        for (const row of input.body.formdata ?? []) {
          if (row.disabled) continue;
          if (row.type === 'file')
            throw new Error('Supply file contents explicitly; filesystem paths are unavailable');
          body.append(row.key, row.value ?? '');
        }
        delete headers['content-type'];
      } else if (input.body?.mode === 'graphql') {
        body = JSON.stringify({
          query: input.body.graphql.query,
          variables: JSON.parse(input.body.graphql.variables || '{}'),
        });
        headers['content-type'] ??= 'application/json';
      } else {
        body = input.body?.raw ?? (typeof input.body === 'string' ? input.body : undefined);
        if (input.body?.options?.raw?.language === 'json' && body)
          headers['content-type'] ??= 'application/json';
      }
    }
    const signal = AbortSignal.timeout(
      Math.min(Math.max(Number(this.#options.timeout) || 30000, 1), 120000),
    );
    let response;
    const origin = new URL(url).origin;
    for (let redirects = 0, digest = false; ;) {
      const hopHeaders = { ...headers };
      if (new URL(url).origin !== origin) {
        delete hopHeaders.authorization;
        delete hopHeaders.cookie;
      }
      const cookie = this.#jar.getCookieStringSync(url);
      if (cookie && !hopHeaders.cookie) hopHeaders.cookie = cookie;
      response = await fetch(url, {
        method,
        headers: hopHeaders,
        body,
        dispatcher: this.#agent,
        redirect: 'manual',
        signal,
      });
      for (const cookie of response.headers.getSetCookie())
        this.#jar.setCookieSync(cookie, url, { ignoreError: true });
      if (
        response.status === 401 &&
        auth.type === 'digest' &&
        !digest &&
        new URL(url).origin === origin
      ) {
        const challenge = response.headers.get('www-authenticate') ?? '';
        if (/^Digest /i.test(challenge)) {
          await response.body?.cancel();
          headers.authorization = digestHeader(challenge, auth, url, method);
          digest = true;
          continue;
        }
      }
      const location = response.headers.get('location');
      if (
        ![301, 302, 303, 307, 308].includes(response.status) ||
        !location ||
        this.#options.followRedirects === false
      )
        break;
      await response.body?.cancel();
      if (++redirects > 20) throw new Error('Maximum redirect count exceeded');
      url = new URL(location, url).href;
      validateUrl(url);
      if (
        (response.status === 303 && method !== 'HEAD') ||
        ([301, 302].includes(response.status) && method === 'POST')
      ) {
        method = 'GET';
        body = undefined;
        delete headers['content-type'];
        delete headers['content-length'];
      }
    }
    const chunks = [];
    let size = 0,
      truncated = false;
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > 8 * 1024 * 1024) {
        truncated = true;
        break;
      }
      chunks.push(Buffer.from(chunk));
    }
    return {
      url,
      method,
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers].map(([key, value]) => ({ key, value })),
      body: Buffer.concat(chunks).toString('utf8'),
      size,
      time: Date.now() - started,
      cookies: this.#jar.getCookiesSync(url).map((cookie) => cookie.toJSON()),
      ...(truncated ? { truncated: true } : {}),
    };
  }
  async close() {
    await this.#agent.destroy();
  }
}
