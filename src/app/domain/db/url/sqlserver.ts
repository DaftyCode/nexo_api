/**
 * SQL Server's URLs, as JDBC writes them (`sqlserver://host\instance:1433;databaseName=shop;
 * encrypt=true`) and as Go and others do (`sqlserver://user:password@host:1433/instance?
 * database=shop`). `{{variables}}` may stand anywhere.
 */
import type { TlsMode } from '../connection';
import type { ParsedUrl, UrlParts } from '../url';

function decode(text: string) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** `host`, `host:port`, `host\instance` or `host\instance:port`. */
function server(text: string, parsed: ParsedUrl) {
  // The last colon outside a variable.
  let [depth, colon] = [0, -1];
  for (let index = 0; index < text.length; index++) {
    if (text.startsWith('{{', index)) [depth, index] = [depth + 1, index + 1];
    else if (text.startsWith('}}', index)) [depth, index] = [Math.max(0, depth - 1), index + 1];
    else if (text[index] === ':' && !depth) colon = index;
  }
  const [address, port] = colon >= 0 ? [text.slice(0, colon), text.slice(colon + 1)] : [text, ''];
  const slash = address.indexOf('\\');
  parsed.host = slash >= 0 ? address.slice(0, slash) : address;
  parsed.port = port;
  if (slash >= 0 && address.slice(slash + 1)) parsed.params['instance'] = address.slice(slash + 1);
}

/** What `encrypt` and `trustServerCertificate` say, as a TLS mode and the strict setting. */
function encryption(parsed: ParsedUrl, encrypt?: string, trust?: string) {
  if (encrypt === undefined && trust === undefined) return;
  const value = (encrypt ?? 'true').toLowerCase();
  const trusted = (trust ?? '').toLowerCase() === 'true';
  if (['false', 'no', 'optional', 'disable'].includes(value)) parsed.tlsMode = 'disable';
  else if (value === 'strict') {
    parsed.tlsMode = 'verify';
    parsed.params['strict'] = 'true';
  } else parsed.tlsMode = trusted ? 'require' : 'verify';
}

/** Reads a property of the URL; true when it is one. */
function property(parsed: ParsedUrl, name: string, value: string): boolean {
  switch (name.toLowerCase()) {
    case 'databasename':
    case 'database':
    case 'initial catalog':
      parsed.database = value;
      return true;
    case 'user':
    case 'username':
    case 'user id':
    case 'uid':
      parsed.user = value;
      return true;
    case 'password':
    case 'pwd':
      parsed.password = value;
      return true;
    case 'servername':
      parsed.host = value;
      return true;
    case 'portnumber':
    case 'port':
      parsed.port = value;
      return true;
    case 'instancename':
      parsed.params['instance'] = value;
      return true;
    case 'applicationname':
    case 'app name':
      parsed.params['application_name'] = value;
      return true;
    default:
      return false;
  }
}

/** Reads what follows `sqlserver://`. */
export function parseSqlServerUrl(rest: string): ParsedUrl {
  const parsed: ParsedUrl = {
    driver: 'mssql',
    host: '',
    port: '',
    database: '',
    user: '',
    params: {},
    ignored: [],
  };
  const pairs: [string, string][] = [];
  if (rest.includes(';') || !/[@/?]/.test(rest)) {
    // JDBC: host[\instance][:port];name=value;…
    const [address, ...properties] = rest.split(';');
    server(address, parsed);
    for (const pair of properties) {
      const equals = pair.indexOf('=');
      if (equals > 0) pairs.push([pair.slice(0, equals).trim(), pair.slice(equals + 1).trim()]);
    }
  } else {
    // URL: [user[:password]@]host[:port][/instance][?name=value&…]
    const question = rest.indexOf('?');
    const query = question >= 0 ? rest.slice(question + 1) : '';
    const main = question >= 0 ? rest.slice(0, question) : rest;
    const at = main.lastIndexOf('@');
    const userinfo = at >= 0 ? main.slice(0, at) : '';
    const [address, instance] = (at >= 0 ? main.slice(at + 1) : main).split('/');
    server(address, parsed);
    if (instance) parsed.params['instance'] = decode(instance);
    const colon = userinfo.indexOf(':');
    parsed.user = decode(colon >= 0 ? userinfo.slice(0, colon) : userinfo);
    if (colon >= 0) parsed.password = decode(userinfo.slice(colon + 1));
    for (const pair of query.split('&').filter(Boolean)) {
      const equals = pair.indexOf('=');
      pairs.push([
        decode(equals >= 0 ? pair.slice(0, equals) : pair),
        decode((equals >= 0 ? pair.slice(equals + 1) : '').replace(/\+/g, ' ')),
      ]);
    }
  }
  const find = (name: string) => pairs.find(([key]) => key.toLowerCase() === name)?.[1];
  encryption(parsed, find('encrypt'), find('trustservercertificate'));
  for (const [name, value] of pairs) {
    const lower = name.toLowerCase();
    if (lower === 'encrypt' || lower === 'trustservercertificate') continue;
    if (!property(parsed, name, value)) parsed.ignored.push(name);
  }
  return parsed;
}

const ENCRYPTION: Record<TlsMode, string> = {
  disable: 'encrypt=false',
  prefer: 'encrypt=true;trustServerCertificate=true',
  require: 'encrypt=true;trustServerCertificate=true',
  verify: 'encrypt=true',
};

/** The JDBC URL of a connection, without its password, as DBeaver and the other tools take it. */
export function formatSqlServerUrl(parts: UrlParts): string {
  const setting = (name: string) =>
    parts.params.find((param) => param.name.trim() === name)?.value.trim() ?? '';
  const instance = setting('instance');
  const port = parts.port.trim() ? `:${parts.port.trim()}` : '';
  const properties = [
    ...(parts.database.trim() ? [`databaseName=${parts.database.trim()}`] : []),
    ...(parts.user.trim() ? [`user=${parts.user.trim()}`] : []),
    setting('strict') === 'true' ? 'encrypt=strict' : ENCRYPTION[parts.tlsMode],
    ...(setting('application_name') ? [`applicationName=${setting('application_name')}`] : []),
  ];
  const address = `${parts.host.trim()}${instance ? `\\${instance}` : ''}${port}`;
  return `jdbc:sqlserver://${address};${properties.join(';')}`;
}
