#!/usr/bin/env bash
# Starts SQL servers for the database driver tests:
#   25432 PostgreSQL 18 (user nexo), with the data of tools/sql-fixture-seed-postgres.sql
#   25433 PostgreSQL 18 that only takes TLS with a client certificate (a CA made here)
#   25434 PostgreSQL 14, the oldest supported, with the same data
# Prints the NEXO_SQL_* variables the driver and contract tests read, and adds them to
# $GITHUB_ENV in CI.  Usage: tools/sql-fixture.sh start | stop
set -euo pipefail
# Git Bash on Windows would turn arguments such as /CN=… or /certs into Windows paths.
export MSYS_NO_PATHCONV=1

current=postgres:18
oldest=postgres:14
names=(nexo-sql-pg nexo-sql-pg-tls nexo-sql-pg-old)
directory="${NEXO_SQL_FIXTURE_DIR:-${TMPDIR:-/tmp}/nexo-sql-fixture}"

if [[ "${1:-start}" == "stop" ]]; then
  docker rm -f "${names[@]}" >/dev/null 2>&1 || true
  exit 0
fi

tools="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
rm -rf "$directory"
mkdir -p "$directory/certs" "$directory/seed" "$directory/tls-init"
cp "$tools/sql-fixture-seed-postgres.sql" "$directory/seed/"
cd "$directory/certs"
# A private CA, a server certificate for localhost and a client certificate for user nexo.
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=nexo-test-ca" \
  -keyout ca.key -out ca.crt 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" -keyout server.key -out server.csr 2>/dev/null
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\n' > server.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 2 \
  -extfile server.ext -out server.crt 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=nexo" -keyout client.key -out client.csr 2>/dev/null
printf 'extendedKeyUsage=clientAuth\n' > client.ext
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 2 \
  -extfile client.ext -out client.crt 2>/dev/null
# PKCS#8, as the SDK reads client keys.
openssl pkcs8 -topk8 -nocrypt -in client.key -out client.pk8 2>/dev/null
chmod 644 ./*
# The TLS server copies its files where PostgreSQL accepts them (its key only for itself),
# turns TLS on and takes only TLS connections with a certificate of the CA.
cat > "$directory/tls-init/tls.sh" <<'EOF'
#!/bin/bash
set -e
cp /certs/server.crt /certs/server.key /certs/ca.crt "$PGDATA/"
chmod 600 "$PGDATA/server.key"
cat > "$PGDATA/pg_hba.conf" <<'HBA'
local all all trust
hostssl all all all scram-sha-256 clientcert=verify-ca
hostnossl all all all reject
HBA
psql -v ON_ERROR_STOP=1 -U nexo -d shop -c "ALTER SYSTEM SET ssl = on" \
  -c "ALTER SYSTEM SET ssl_ca_file = 'ca.crt'"
EOF
chmod 755 "$directory/tls-init/tls.sh"
cd "$directory"

docker rm -f "${names[@]}" >/dev/null 2>&1 || true
server=(-e POSTGRES_USER=nexo -e POSTGRES_PASSWORD=nexo-secret -e POSTGRES_DB=shop)
docker run -d --name nexo-sql-pg -p 25432:5432 "${server[@]}" \
  -v "$directory/seed:/docker-entrypoint-initdb.d:ro" "$current" >/dev/null
docker run -d --name nexo-sql-pg-tls -p 25433:5432 "${server[@]}" \
  -v "$directory/certs:/certs:ro" -v "$directory/tls-init:/docker-entrypoint-initdb.d:ro" "$current" >/dev/null
docker run -d --name nexo-sql-pg-old -p 25434:5432 "${server[@]}" \
  -v "$directory/seed:/docker-entrypoint-initdb.d:ro" "$oldest" >/dev/null

# Ready once the final server (after the init scripts) answers over TCP.
ready() { docker exec "$1" psql -h 127.0.0.1 -U nexo -d shop -tAc "$2" >/dev/null 2>&1; }
started=false
for _ in $(seq 1 90); do
  if ready nexo-sql-pg "SELECT count(*) FROM public.every_type" \
    && ready nexo-sql-pg-old "SELECT count(*) FROM public.every_type" \
    && docker exec nexo-sql-pg-tls pg_isready -h 127.0.0.1 -U nexo >/dev/null 2>&1 \
    && docker logs nexo-sql-pg-tls 2>&1 | grep -q "PostgreSQL init process complete"; then
    started=true
    break
  fi
  sleep 2
done
if [[ "$started" != true ]]; then
  for name in "${names[@]}"; do
    echo "== $name: $(docker inspect -f '{{.State.Status}} (exit {{.State.ExitCode}})' "$name")" >&2
    docker logs --tail 30 "$name" 2>&1 | tail -30 >&2 || true
  done
  echo "The SQL servers did not start" >&2
  exit 1
fi

variables="NEXO_SQL_PG_HOST=127.0.0.1
NEXO_SQL_PG_PORT=25432
NEXO_SQL_PG_TLS_PORT=25433
NEXO_SQL_PG_OLD_PORT=25434
NEXO_SQL_PG_USER=nexo
NEXO_SQL_PG_PASSWORD=nexo-secret
NEXO_SQL_PG_DATABASE=shop
NEXO_SQL_PG_CA=$directory/certs/ca.crt
NEXO_SQL_PG_CLIENT_CERT=$directory/certs/client.crt
NEXO_SQL_PG_CLIENT_KEY=$directory/certs/client.pk8"
echo "$variables"
if [[ -n "${GITHUB_ENV:-}" ]]; then echo "$variables" >> "$GITHUB_ENV"; fi
