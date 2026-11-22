/**
 * MySQL Workbench's `connections.xml` (in its user folder): each `db.mgmt.Connection` with its
 * driver (TCP, through SSH, or a local socket, which Nexo does not reach), host, port, user,
 * default schema and SSL setting. Workbench keeps passwords in the system's keychain.
 */
import { XmlElement, parseXml, xmlElements } from '../../xml';
import type { DbConnectionValue, TlsMode } from '../connection';
import { ConnectionImport, ImportBuilder } from './builder';

/** Its `useSSL`: 0 no, 1 if the server has it, 2 required, 3 and 4 verified. */
const SSL: Record<string, TlsMode> = {
  '0': 'disable',
  '1': 'prefer',
  '2': 'require',
  '3': 'verify',
  '4': 'verify',
};

/** The values of an object by their key. */
function values(element: XmlElement): Map<string, XmlElement> {
  const found = new Map<string, XmlElement>();
  for (const child of element.children) {
    const key = child.attributes['key'];
    if (key) found.set(key, child);
  }
  return found;
}

export function readWorkbench(source: string, builder: ImportBuilder): ConnectionImport {
  let root: XmlElement;
  try {
    root = parseXml(source);
  } catch {
    throw new Error('Nexo does not know the connections of this file');
  }
  const connections = xmlElements(root, 'value').filter(
    (element) =>
      element.attributes['type'] === 'object' &&
      element.attributes['struct-name'] === 'db.mgmt.Connection',
  );
  if (!connections.length && root.name !== 'data')
    throw new Error('Nexo does not know the connections of this file');
  for (const connection of connections) {
    const fields = values(connection);
    const name = fields.get('name')?.text || 'MySQL';
    const driver = fields.get('driver')?.text ?? '';
    const parameters = values(fields.get('parameterValues') ?? connection);
    const parameter = (key: string) => parameters.get(key)?.text ?? '';
    if (/socket/i.test(driver)) {
      builder.skip(name, 'socket');
      continue;
    }
    let route: DbConnectionValue['route'];
    if (/sshtun/i.test(driver)) {
      const [host, port] = parameter('sshHost').split(':');
      const user = parameter('sshUserName');
      if (!user) builder.note('user', name);
      const key = !!parameter('sshKeyFile');
      route = { via: 'ssh', profile: builder.ssh(host, Number(port) || 22, user, key, name) };
    }
    const mode = SSL[parameter('useSSL')];
    const port = Number(parameter('port'));
    builder.connection(name, {
      driver: 'mysql',
      host: parameter('hostName') || '127.0.0.1',
      port: Number.isInteger(port) && port > 0 ? port : undefined,
      database: parameter('schema') || undefined,
      user: parameter('userName') || undefined,
      tls: mode && mode !== 'disable' ? { mode } : undefined,
      route,
    });
  }
  return builder.result();
}
