#!/usr/bin/env bash
# Starts MongoDB servers for the MongoDB contract tests:
#   27117 standalone without authentication, with the data of tools/mongo-fixture-seed.js
#   27118 SCRAM (user nexo) and X.509, with TLS allowed (a CA made here)
#   27119 a one-member replica set (rs0)
#   27120 FerretDB (user nexo), a compatible server on PostgreSQL
# Prints the NEXO_MONGO_* variables tests/contract/mongo.test.mjs reads, and adds them to
# $GITHUB_ENV in CI.  Usage: tools/mongo-fixture.sh start | stop
set -euo pipefail
# Git Bash on Windows would turn arguments such as /CN=… or /certs into Windows paths.
export MSYS_NO_PATHCONV=1

image=mongo:8.0
ferretdb=ghcr.io/ferretdb/ferretdb-eval:2
names=(nexo-mongo-plain nexo-mongo-auth nexo-mongo-rs nexo-mongo-ferretdb)
directory="${NEXO_MONGO_FIXTURE_DIR:-${TMPDIR:-/tmp}/nexo-mongo-fixture}"

if [[ "${1:-start}" == "stop" ]]; then
  docker rm -f "${names[@]}" >/dev/null 2>&1 || true
  exit 0
fi

tools="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
rm -rf "$directory"
mkdir -p "$directory/certs"
cd "$directory/certs"
# A private CA, a server certificate for localhost and a client certificate for X.509.
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=nexo-test-ca" \
  -keyout ca.key -out ca.crt 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost/O=Nexo Server" \
  -keyout server.key -out server.csr 2>/dev/null
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\n' > server.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 2 \
  -extfile server.ext -out server.crt 2>/dev/null
cat server.crt server.key > server.pem
openssl req -newkey rsa:2048 -nodes -subj "/CN=nexo-client/OU=clients/O=Nexo Clients" \
  -keyout client.key -out client.csr 2>/dev/null
printf 'extendedKeyUsage=clientAuth\n' > client.ext
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 2 \
  -extfile client.ext -out client.crt 2>/dev/null
chmod 644 ./*
cd "$directory"

docker rm -f "${names[@]}" >/dev/null 2>&1 || true
# The image sets GLIBC_TUNABLES=glibc.pthread.rseq=0, and MongoDB 8.0 refuses to start that
# way on Linux 6.19 and newer (GitHub's ubuntu-24.04 runners have 7.0). With rseq on, its
# TCMalloc works on every kernel (SERVER-121912).
rseq=(-e GLIBC_TUNABLES=glibc.pthread.rseq=1)
docker run -d --name nexo-mongo-plain "${rseq[@]}" -p 27117:27017 "$image" --quiet >/dev/null
docker run -d --name nexo-mongo-auth "${rseq[@]}" -p 27118:27017 \
  -e MONGO_INITDB_ROOT_USERNAME=nexo -e MONGO_INITDB_ROOT_PASSWORD=nexo-secret \
  -v "$directory/certs:/certs:ro" "$image" --quiet \
  --tlsMode allowTLS --tlsCertificateKeyFile /certs/server.pem --tlsCAFile /certs/ca.crt \
  --tlsAllowConnectionsWithoutCertificates >/dev/null
docker run -d --name nexo-mongo-rs "${rseq[@]}" -p 27119:27119 "$image" --quiet \
  --replSet rs0 --port 27119 --bind_ip_all >/dev/null
docker run -d --name nexo-mongo-ferretdb -p 27120:27017 \
  -e POSTGRES_USER=nexo -e POSTGRES_PASSWORD=nexo-secret "$ferretdb" >/dev/null

ready() { docker exec "$1" mongosh --quiet --port "$2" "${@:3}" --eval 'db.runCommand({ping: 1}).ok' >/dev/null 2>&1; }
started=false
for _ in $(seq 1 60); do
  if ready nexo-mongo-plain 27017 && ready nexo-mongo-rs 27119 \
    && ready nexo-mongo-auth 27017 -u nexo -p nexo-secret; then started=true; break; fi
  sleep 2
done
# Say which server did not start, and why, instead of failing later on a stopped container.
if [[ "$started" != true ]]; then
  for name in nexo-mongo-plain nexo-mongo-auth nexo-mongo-rs; do
    echo "== $name: $(docker inspect -f '{{.State.Status}} (exit {{.State.ExitCode}})' "$name")" >&2
    docker logs --tail 30 "$name" 2>&1 | tail -30 >&2 || true
  done
  echo "The MongoDB servers did not start" >&2
  exit 1
fi
# The replica set announces 127.0.0.1:27119, which tests reach through the published port.
docker exec nexo-mongo-rs mongosh --quiet --port 27119 --eval \
  "rs.initiate({_id: 'rs0', members: [{_id: 0, host: '127.0.0.1:27119'}]})" >/dev/null
subject=$(openssl x509 -in certs/client.crt -noout -subject -nameopt RFC2253 | sed 's/^subject=//')
docker exec nexo-mongo-auth mongosh --quiet -u nexo -p nexo-secret --eval \
  "db.getSiblingDB('\$external').runCommand({createUser: '$subject', roles: [{role: 'readAnyDatabase', db: 'admin'}]})" >/dev/null
# The data the explorer tests query (100 000 documents, every BSON type, a view…).
docker exec -i nexo-mongo-plain mongosh --quiet nexo < "$tools/mongo-fixture-seed.js" >/dev/null
for _ in $(seq 1 60); do
  if docker exec nexo-mongo-rs mongosh --quiet --port 27119 --eval 'db.hello().isWritablePrimary' 2>/dev/null | grep -q true; then break; fi
  sleep 1
done

variables="NEXO_MONGO_PLAIN=mongodb://127.0.0.1:27117
NEXO_MONGO_AUTH=mongodb://nexo@localhost:27118/?authSource=admin
NEXO_MONGO_PASSWORD=nexo-secret
NEXO_MONGO_CA=$directory/certs/ca.crt
NEXO_MONGO_CLIENT_CERT=$directory/certs/client.crt
NEXO_MONGO_CLIENT_KEY=$directory/certs/client.key
NEXO_MONGO_REPLICA_SET=mongodb://127.0.0.1:27119/?replicaSet=rs0
NEXO_MONGO_FERRETDB=mongodb://nexo@127.0.0.1:27120/"
echo "$variables"
if [[ -n "${GITHUB_ENV:-}" ]]; then echo "$variables" >> "$GITHUB_ENV"; fi
