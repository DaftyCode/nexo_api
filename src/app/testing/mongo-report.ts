/** What «Test connection» answers for a replica set with a server the egress policy refuses. */
export const mongoReport = {
  serverVersion: '8.0.4',
  topology: 'replicaSet',
  replicaSet: 'rs0',
  hosts: [
    { address: 'db1.test:27017', role: 'primary', allowed: true },
    {
      address: '10.0.0.5:27017',
      role: 'secondary',
      allowed: false,
      reason: 'Destination 10.0.0.5 is blocked by the egress policy',
    },
  ],
  pingMs: 3,
  direct: true,
  tls: true,
  authMechanism: 'SCRAM',
};
