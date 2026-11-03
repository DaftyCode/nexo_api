import { parse as parseShell } from 'shell-quote';
import { parse as parseYaml } from 'yaml';
import { collectionSchema, requestItem } from '../domain/collection.mjs';
import { requestUrl } from './transport.mjs';

export async function importArtifact(_, payload) {
  const text = payload.content ?? '';
  if (text.trim().startsWith('curl ')) return importCurl(text);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = parseYaml(text);
  }
  if (json?.info && Array.isArray(json.item))
    return { kind: 'collection', value: json, name: json.info.name };
  if (Array.isArray(json?.values))
    return { kind: 'environment', name: json.name ?? 'Imported environment', value: json };
  if (json?.log?.entries)
    return {
      kind: 'collection',
      name: 'HAR import',
      value: {
        info: { name: 'HAR import', schema: collectionSchema },
        item: json.log.entries.map(({ request }) => ({
          name: request.url,
          request: {
            method: request.method,
            url: request.url,
            header: request.headers,
            ...(request.postData
              ? { body: { mode: 'raw', raw: request.postData.text ?? '' } }
              : {}),
          },
        })),
      },
    };
  if (json?.openapi || json?.swagger === '2.0') return importOpenApi(json);
  throw new Error('Unsupported import format');
}
function importCurl(text) {
  const args = parseShell(text);
  if (args.some((arg) => typeof arg !== 'string'))
    throw new Error('Shell operators are not accepted in cURL imports');
  let method = 'GET',
    url = '',
    body = '';
  const headers = [];
  let auth = { type: 'noauth' };
  const next = (index) => {
    if (typeof args[index] !== 'string') throw new Error('Missing cURL option value');
    return args[index];
  };
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (['-X', '--request'].includes(arg)) method = next(++i).toUpperCase();
    else if (['-H', '--header'].includes(arg)) {
      const value = next(++i),
        index = value.indexOf(':');
      if (index < 1) throw new Error('Invalid cURL header');
      headers.push({ key: value.slice(0, index), value: value.slice(index + 1).trim() });
    } else if (
      ['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--json'].includes(arg)
    ) {
      body = next(++i);
      if (body.startsWith('@'))
        throw new Error('Import the file contents explicitly; cURL file paths are not read');
      if (method === 'GET') method = 'POST';
      if (arg === '--json') headers.push({ key: 'Content-Type', value: 'application/json' });
    } else if (['-u', '--user'].includes(arg)) {
      const value = next(++i),
        split = value.indexOf(':');
      auth = {
        type: 'basic',
        username: split < 0 ? value : value.slice(0, split),
        password: split < 0 ? '' : value.slice(split + 1),
      };
    } else if (arg === '--url') url = next(++i);
    else if (arg === '-I' || arg === '--head') method = 'HEAD';
    else if (/^https?:\/\//.test(arg)) url = arg;
  }
  if (!url) throw new Error('No HTTP URL found in cURL command');
  return {
    kind: 'collection',
    name: 'cURL import',
    value: {
      info: { name: 'cURL import', schema: collectionSchema },
      item: [requestItem({ name: url, method, url, headers, body, auth })],
    },
  };
}
function importOpenApi(spec) {
  const resolve = (value, seen = new Set()) => {
    if (!value?.$ref) return value ?? {};
    if (!value.$ref.startsWith('#/'))
      throw new Error('External references must be bundled into the specification before import');
    if (seen.has(value.$ref)) return {};
    seen.add(value.$ref);
    const target = value.$ref
      .slice(2)
      .split('/')
      .reduce((object, key) => object?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], spec);
    if (!target) throw new Error('Unresolved specification reference');
    return resolve(target, seen);
  };
  const example = (schema, depth = 0) => {
    schema = resolve(schema);
    if (depth > 8) return null;
    if (schema.example !== undefined) return schema.example;
    if (schema.default !== undefined) return schema.default;
    if (schema.enum?.length) return schema.enum[0];
    if (schema.oneOf || schema.anyOf) return example((schema.oneOf ?? schema.anyOf)[0], depth + 1);
    if (schema.allOf)
      return Object.assign({}, ...schema.allOf.map((item) => example(item, depth + 1)));
    if (schema.type === 'object' || schema.properties)
      return Object.fromEntries(
        Object.entries(schema.properties ?? {}).map(([key, item]) => [
          key,
          example(item, depth + 1),
        ]),
      );
    if (schema.type === 'array') return [example(schema.items, depth + 1)];
    if (schema.type === 'integer' || schema.type === 'number') return 0;
    if (schema.type === 'boolean') return false;
    return schema.format === 'date-time' ? '2026-01-01T00:00:00Z' : 'string';
  };
  const serverUrl = (servers) => {
    const server = servers?.[0];
    if (!server)
      return spec.host
        ? `${spec.schemes?.[0] ?? 'https'}://${spec.host}${spec.basePath ?? ''}`
        : '{{base_url}}';
    return server.url.replace(
      /\{([^}]+)\}/g,
      (_, key) => server.variables?.[key]?.default ?? `{{${key}}}`,
    );
  };
  const schemes = spec.components?.securitySchemes ?? spec.securityDefinitions ?? {};
  const authentication = (requirements) => {
    const [name] = Object.keys(requirements?.[0] ?? {}),
      security = resolve(schemes[name]);
    if (!name) return { type: 'noauth' };
    if (security.type === 'apiKey')
      return { type: 'apikey', key: security.name, value: '{{api_key}}', in: security.in };
    if (security.type === 'basic' || security.scheme === 'basic')
      return { type: 'basic', username: '{{username}}', password: '{{password}}' };
    return { type: 'bearer', token: '{{access_token}}' };
  };
  const folders = new Map();
  for (const [path, pathSource] of Object.entries(spec.paths ?? {})) {
    const entry = resolve(pathSource);
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']) {
      if (!entry[method]) continue;
      const operation = resolve(entry[method]),
        headers = [],
        query = [];
      let endpoint =
        serverUrl(operation.servers ?? entry.servers ?? spec.servers).replace(/\/$/, '') +
        path.replace(/\{([^}]+)\}/g, '{{$1}}');
      const parameters = [...(entry.parameters ?? []), ...(operation.parameters ?? [])].map(
        (parameter) => resolve(parameter),
      );
      for (const parameter of parameters) {
        const value =
          parameter.example ?? parameter.examples?.[0] ?? example(parameter.schema ?? parameter);
        if (parameter.in === 'query')
          query.push({ key: parameter.name, value: String(value), enabled: true });
        if (parameter.in === 'header')
          headers.push({ key: parameter.name, value: String(value), enabled: true });
      }
      const requestBody = resolve(operation.requestBody),
        content = requestBody.content ?? {},
        media = Object.keys(content).find((key) => key.includes('json')) ?? Object.keys(content)[0];
      const bodySource = media
        ? content[media]
        : parameters.find((parameter) => parameter.in === 'body');
      const bodyExample = bodySource
        ? (bodySource.example ??
          Object.values(bodySource.examples ?? {}).map((item) => resolve(item).value)[0] ??
          example(bodySource.schema))
        : undefined;
      if (media) headers.push({ key: 'Content-Type', value: media, enabled: true });
      const item = requestItem({
        name: operation.summary ?? operation.operationId ?? `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        url: endpoint,
        query,
        headers,
        body:
          bodyExample === undefined
            ? ''
            : typeof bodyExample === 'string'
              ? bodyExample
              : JSON.stringify(bodyExample, null, 2),
        auth: authentication(operation.security ?? spec.security),
      });
      item.request.description = operation.description ?? '';
      const folder = operation.tags?.[0] ?? 'Requests';
      if (!folders.has(folder)) folders.set(folder, []);
      folders.get(folder).push(item);
    }
  }
  const name = spec.info?.title ?? 'API import';
  return {
    kind: 'collection',
    name,
    value: {
      info: { name, schema: collectionSchema, description: spec.info?.description ?? '' },
      item: [...folders].map(([name, item]) => ({ name, item })),
    },
  };
}
export function generateCode(_, payload) {
  const languages = [
    ['cURL', 'cURL'],
    ['JavaScript', 'Fetch'],
    ['NodeJs', 'Fetch'],
    ['Python', 'http.client'],
    ['Java', 'HttpClient'],
    ['Go', 'Native'],
    ['Rust', 'reqwest'],
    ['C#', 'HttpClient'],
    ['PowerShell', 'RestMethod'],
  ];
  if (payload.languages)
    return languages.map(([key, variant]) => ({
      key,
      label: key,
      variants: [{ key: variant, label: variant }],
    }));
  const request = requestItem(payload.request).request;
  let url = requestUrl(request.url);
  const method = request.method;
  const headers = Object.fromEntries((request.header ?? []).map(({ key, value }) => [key, value]));
  const auth = request.auth ?? {};
  const get = (key) => auth[auth.type]?.find((row) => row.key === key)?.value ?? auth[key];
  if (auth.type === 'basic')
    headers.Authorization = `Basic ${Buffer.from(`${get('username')}:${get('password')}`).toString('base64')}`;
  if (auth.type === 'bearer') headers.Authorization = `Bearer ${get('token')}`;
  if (auth.type === 'apikey') {
    if (get('in') === 'query')
      url += `${url.includes('?') ? '&' : '?'}${encodeURIComponent(get('key'))}=${encodeURIComponent(get('value'))}`;
    else headers[get('key')] = get('value');
  }
  let body = request.body?.raw ?? '';
  if (request.body?.mode === 'urlencoded') {
    body = new URLSearchParams(
      (request.body.urlencoded ?? []).map(({ key, value }) => [key, value]),
    ).toString();
    headers['Content-Type'] ??= 'application/x-www-form-urlencoded';
  }
  if (request.body?.mode === 'graphql') {
    body = JSON.stringify({
      query: request.body.graphql.query,
      variables: JSON.parse(request.body.graphql.variables || '{}'),
    });
    headers['Content-Type'] ??= 'application/json';
  }
  const q = JSON.stringify,
    shell = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
  let code;
  switch ((payload.language ?? 'cURL').toLowerCase()) {
    case 'curl':
      code = `curl --request ${shell(method)} ${shell(url)}${Object.entries(headers)
        .map(([key, value]) => ` \\\n  --header ${shell(`${key}: ${value}`)}`)
        .join('')}${
        request.body?.mode === 'formdata'
          ? (request.body.formdata ?? [])
              .filter((row) => !row.disabled)
              .map(({ key, value }) => ` \\\n  --form-string ${shell(`${key}=${value}`)}`)
              .join('')
          : body
            ? ` \\\n  --data-raw ${shell(body)}`
            : ''
      }`;
      break;
    case 'javascript':
    case 'nodejs':
      code = `const response = await fetch(${q(url)}, ${JSON.stringify({ method, headers, ...(body && !['GET', 'HEAD'].includes(method) ? { body } : {}), redirect: payload.followRedirects === false ? 'manual' : 'follow' }, null, 2)});\nconsole.log(response.status, await response.text());`;
      break;
    case 'python': {
      const parsed = new URL(url);
      code = `import http.client\n\nconnection = http.client.${parsed.protocol === 'https:' ? 'HTTPSConnection' : 'HTTPConnection'}(${q(parsed.host)})\nconnection.request(${q(method)}, ${q(parsed.pathname + parsed.search)}, body=${q(body)}, headers={${Object.entries(
        headers,
      )
        .map(([key, value]) => `${q(key)}: ${q(value)}`)
        .join(
          ', ',
        )}})\nresponse = connection.getresponse()\nprint(response.status, response.read().decode())\nconnection.close()`;
      break;
    }
    case 'go':
      code = `package main\n\nimport ("fmt"; "io"; "net/http"; "strings")\n\nfunc main() {\n  req, err := http.NewRequest(${q(method)}, ${q(url)}, strings.NewReader(${q(body)}))\n  if err != nil { panic(err) }\n${Object.entries(
        headers,
      )
        .map(([key, value]) => `  req.Header.Set(${q(key)}, ${q(value)})`)
        .join(
          '\n',
        )}\n  res, err := http.DefaultClient.Do(req)\n  if err != nil { panic(err) }\n  defer res.Body.Close()\n  data, err := io.ReadAll(res.Body)\n  if err != nil { panic(err) }\n  fmt.Println(res.Status, string(data))\n}`;
      break;
    case 'rust':
      code = `let client = reqwest::Client::new();\nlet response = client.request(reqwest::Method::from_bytes(${q(method)}.as_bytes())?, ${q(url)})${Object.entries(
        headers,
      )
        .map(([key, value]) => `\n    .header(${q(key)}, ${q(value)})`)
        .join(
          '',
        )}${body ? `\n    .body(${q(body)})` : ''}\n    .send().await?;\nprintln!("{} {}", response.status(), response.text().await?);`;
      break;
    case 'java':
      code = `var client = java.net.http.HttpClient.newBuilder().followRedirects(java.net.http.HttpClient.Redirect.${payload.followRedirects === false ? 'NEVER' : 'NORMAL'}).build();\nvar request = java.net.http.HttpRequest.newBuilder(java.net.URI.create(${q(url)}))\n    .method(${q(method)}, java.net.http.HttpRequest.BodyPublishers.ofString(${q(body)}))${Object.entries(
        headers,
      )
        .map(([key, value]) => `\n    .header(${q(key)}, ${q(value)})`)
        .join(
          '',
        )}\n    .build();\nvar response = client.send(request, java.net.http.HttpResponse.BodyHandlers.ofString());\nSystem.out.println(response.body());`;
      break;
    case 'csharp':
    case 'c#':
      code = `using var client = new HttpClient();\nusing var request = new HttpRequestMessage(new HttpMethod(${q(method)}), ${q(url)});\n${body ? `request.Content = new StringContent(${q(body)});\n` : ''}${Object.entries(
        headers,
      )
        .map(([key, value]) =>
          key.toLowerCase() === 'content-type' && body
            ? `request.Content.Headers.ContentType = System.Net.Http.Headers.MediaTypeHeaderValue.Parse(${q(value)});`
            : `request.Headers.TryAddWithoutValidation(${q(key)}, ${q(value)});`,
        )
        .join(
          '\n',
        )}\nusing var response = await client.SendAsync(request);\nConsole.WriteLine(await response.Content.ReadAsStringAsync());`;
      break;
    case 'powershell':
      code = `Invoke-RestMethod -Method ${method} -Uri '${url.replaceAll("'", "''")}' -Headers @{${Object.entries(
        headers,
      )
        .map(
          ([key, value]) =>
            `'${key.replaceAll("'", "''")}'='${String(value).replaceAll("'", "''")}'`,
        )
        .join('; ')}}${body ? ` -Body '${body.replaceAll("'", "''")}'` : ''}`;
      break;
    default:
      throw new Error('Unsupported code generation language');
  }
  return { code };
}
