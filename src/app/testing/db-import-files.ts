/**
 * Files of connections as DBeaver, pgAdmin and MySQL Workbench write them, shortened from real
 * exports (their ids and secrets replaced), for the tables of cases of the importers.
 */

/** DBeaver 24's `data-sources.json`: folders, a tunnel, a proxy, a custom type and Oracle. */
export const DBEAVER_DATA_SOURCES = JSON.stringify({
  folders: { Shop: {}, 'Shop EU': { parent: 'Shop' }, Local: {} },
  'connection-types': { staging: { name: 'Staging', color: '255,128,0' } },
  connections: {
    'postgres-jdbc-18c2a1b2c3d-5f1a2b3c4d5e6f70': {
      provider: 'postgresql',
      driver: 'postgres-jdbc',
      name: 'Orders (EU)',
      'save-password': true,
      'read-only': true,
      folder: 'Shop EU',
      configuration: {
        host: 'db.internal',
        port: '5432',
        database: 'orders',
        url: 'jdbc:postgresql://db.internal:5432/orders',
        type: 'prod',
        user: 'reports',
        'auth-model': 'native',
        bootstrap: {
          autocommit: false,
          defaultSchema: 'sales',
          initQueries: ["SET application_name = 'nexo'"],
        },
        handlers: {
          ssh_tunnel: {
            type: 'TUNNEL',
            enabled: true,
            'save-password': true,
            properties: { host: 'bastion.example.com', port: 2222, authType: 'PUBLIC_KEY' },
          },
          postgre_ssl: {
            type: 'CONFIG',
            enabled: true,
            properties: { sslMode: 'verify-full', 'ssl.ca.cert': '/home/ana/ca.pem' },
          },
        },
      },
    },
    'mysql8-18c2a1b2c3e-1a2b3c4d5e6f7081': {
      provider: 'mysql',
      driver: 'mysql8',
      name: 'Catalog',
      folder: 'Shop',
      configuration: {
        host: 'mysql.internal',
        port: '3306',
        database: 'catalog',
        type: 'staging',
        handlers: {
          ssh_tunnel: {
            type: 'TUNNEL',
            enabled: true,
            properties: { host: 'bastion.example.com', port: 2222, authType: 'PASSWORD' },
          },
          socks_proxy: { type: 'PROXY', enabled: false, properties: {} },
        },
      },
    },
    'sqlite_jdbc-18c2a1b2c3f-0a1b2c3d4e5f6071': {
      provider: 'generic',
      driver: 'sqlite_jdbc',
      name: 'Scratch',
      folder: 'Local',
      configuration: { url: 'jdbc:sqlite:C:\\data\\scratch.db', type: 'dev' },
    },
    'mssql_jdbc_ms_new-18c2a1b2c40-1b2c3d4e5f607182': {
      provider: 'sqlserver',
      driver: 'mssql_jdbc_ms_new',
      name: 'Billing',
      configuration: {
        host: 'sql.example.com',
        port: '1433',
        database: 'billing',
        user: 'sa',
        type: 'test',
        handlers: {
          socks_proxy: {
            type: 'PROXY',
            enabled: true,
            properties: { 'socks-host': 'proxy.example.com', 'socks-port': 1080 },
          },
        },
      },
    },
    'oracle_thin-18c2a1b2c41-2c3d4e5f60718293': {
      provider: 'oracle',
      driver: 'oracle_thin',
      name: 'Legacy',
      configuration: { host: 'ora', port: '1521', database: 'XE' },
    },
  },
});

/** pgAdmin 8's «Export Servers»: groups, a pass file, SSL and an SSH tunnel. */
export const PGADMIN_SERVERS = JSON.stringify({
  Servers: {
    '1': {
      Name: 'Local',
      Group: 'Servers',
      Host: 'localhost',
      Port: 5432,
      MaintenanceDB: 'postgres',
      Username: 'postgres',
      ConnectionParameters: { sslmode: 'prefer', connect_timeout: 10 },
    },
    '2': {
      Name: 'Reports',
      Group: 'Production',
      Host: 'db.internal',
      Port: 5433,
      MaintenanceDB: 'reports',
      Username: 'reader',
      Comment: 'Read replica',
      UseSSHTunnel: 1,
      TunnelHost: 'bastion.example.com',
      TunnelPort: '22',
      TunnelUsername: 'ana',
      TunnelAuthentication: 1,
      ConnectionParameters: {
        sslmode: 'verify-full',
        sslrootcert: '/home/ana/ca.pem',
        passfile: '/home/ana/.pgpass',
        connect_timeout: 300,
      },
    },
  },
});

/** MySQL Workbench 8's `connections.xml`: TCP with SSL, through SSH, and a local socket. */
export const WORKBENCH_CONNECTIONS = `<?xml version="1.0"?>
<data grt_format="2.0">
  <value _ptr_="0x6000020e8000" type="list" content-type="object" content-struct-name="db.mgmt.Connection">
    <value type="object" struct-name="db.mgmt.Connection" id="{A1B2C3D4-0001}" struct-checksum="0x96ba47d8">
      <link type="object" struct-name="db.mgmt.Driver" key="driver">com.mysql.rdbms.mysql.driver.native</link>
      <value type="string" key="hostIdentifier">Mysql@127.0.0.1:3306</value>
      <value _ptr_="0x6000020e8100" type="dict" key="parameterValues">
        <value type="string" key="hostName">127.0.0.1</value>
        <value type="int" key="port">3306</value>
        <value type="string" key="schema">shop</value>
        <value type="string" key="userName">root</value>
        <value type="int" key="useSSL">2</value>
        <!-- Workbench keeps the password in the system's keychain -->
      </value>
      <value type="string" key="name">Shop &amp; stock</value>
    </value>
    <value type="object" struct-name="db.mgmt.Connection" id="{A1B2C3D4-0002}" struct-checksum="0x96ba47d8">
      <link type="object" struct-name="db.mgmt.Driver" key="driver">com.mysql.rdbms.mysql.driver.native_sshtun</link>
      <value _ptr_="0x6000020e8200" type="dict" key="parameterValues">
        <value type="string" key="hostName">10.0.0.5</value>
        <value type="int" key="port">3307</value>
        <value type="string" key="sshHost">bastion.example.com:2200</value>
        <value type="string" key="sshUserName">ana</value>
        <value type="string" key="sshKeyFile"></value>
        <value type="string" key="userName">app</value>
        <value type="int" key="useSSL">0</value>
      </value>
      <value type="string" key="name">Remote</value>
    </value>
    <value type="object" struct-name="db.mgmt.Connection" id="{A1B2C3D4-0003}" struct-checksum="0x96ba47d8">
      <link type="object" struct-name="db.mgmt.Driver" key="driver">com.mysql.rdbms.mysql.driver.native_socket</link>
      <value _ptr_="0x6000020e8300" type="dict" key="parameterValues">
        <value type="string" key="socket">/var/run/mysqld/mysqld.sock</value>
      </value>
      <value type="string" key="name">Socket</value>
    </value>
  </value>
</data>
`;
