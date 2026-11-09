#!/usr/bin/env bash
# Starts a Redpanda broker for the Kafka contract tests, with three listeners:
#   19092 plaintext, 29092 SASL (SCRAM-SHA-256, user nexo), 39092 TLS (a CA made here).
# Prints the NEXO_KAFKA_* variables tests/contract/kafka.test.mjs reads, and adds them to
# $GITHUB_ENV in CI.  Usage: tools/kafka-fixture.sh start | stop
set -euo pipefail
# Git Bash on Windows would turn arguments such as /CN=… or /certs into Windows paths.
export MSYS_NO_PATHCONV=1

name=nexo-redpanda
image=docker.redpanda.com/redpandadata/redpanda:v24.2.7
directory="${NEXO_KAFKA_FIXTURE_DIR:-${TMPDIR:-/tmp}/nexo-kafka-fixture}"

if [[ "${1:-start}" == "stop" ]]; then
  docker rm -f "$name" >/dev/null 2>&1 || true
  exit 0
fi

rm -rf "$directory"
mkdir -p "$directory/certs"
cd "$directory/certs"
# A private CA and a broker certificate for localhost.
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=nexo-test-ca" \
  -keyout ca.key -out ca.crt
openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" -keyout broker.key -out broker.csr
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\n' > broker.ext
openssl x509 -req -in broker.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 2 \
  -extfile broker.ext -out broker.crt
chmod 644 ./*
cd "$directory"

cat > redpanda.yaml <<'YAML'
redpanda:
  data_directory: /var/lib/redpanda/data
  developer_mode: true
  seed_servers: []
  rpc_server:
    address: 0.0.0.0
    port: 33145
  advertised_rpc_api:
    address: 127.0.0.1
    port: 33145
  kafka_api:
    - name: plain
      address: 0.0.0.0
      port: 19092
    - name: sasl
      address: 0.0.0.0
      port: 29092
      authentication_method: sasl
    - name: tls
      address: 0.0.0.0
      port: 39092
  advertised_kafka_api:
    - name: plain
      address: 127.0.0.1
      port: 19092
    - name: sasl
      address: 127.0.0.1
      port: 29092
    - name: tls
      address: localhost
      port: 39092
  kafka_api_tls:
    - name: tls
      enabled: true
      cert_file: /certs/broker.crt
      key_file: /certs/broker.key
      truststore_file: /certs/ca.crt
      require_client_auth: false
  admin:
    - address: 0.0.0.0
      port: 9644
YAML

docker rm -f "$name" >/dev/null 2>&1 || true
# The configuration is written inside the container: rpk rewrites it at start, which a file
# mounted from the host (owned by another user) does not allow.
docker run -d --name "$name" \
  -p 19092:19092 -p 29092:29092 -p 39092:39092 -p 9644:9644 \
  -e NEXO_REDPANDA_CONFIG="$(base64 < redpanda.yaml | tr -d '\n')" \
  -v "$directory/certs:/certs:ro" \
  --entrypoint bash "$image" -c \
  'echo "$NEXO_REDPANDA_CONFIG" | base64 -d > /etc/redpanda/redpanda.yaml && exec /entrypoint.sh redpanda start --overprovisioned --smp 1 --memory 1G --reserve-memory 0M --check=false --default-log-level=warn' \
  >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$name" rpk cluster health --exit-when-healthy >/dev/null 2>&1; then break; fi
  sleep 2
done
docker exec "$name" rpk cluster config set auto_create_topics_enabled true >/dev/null
docker exec "$name" rpk security user create nexo -p nexo-secret --mechanism SCRAM-SHA-256 >/dev/null

variables="NEXO_KAFKA_BROKERS=127.0.0.1:19092
NEXO_KAFKA_SASL_BROKERS=127.0.0.1:29092
NEXO_KAFKA_SASL_USER=nexo
NEXO_KAFKA_SASL_PASSWORD=nexo-secret
NEXO_KAFKA_SASL_MECHANISM=SCRAM-SHA-256
NEXO_KAFKA_TLS_BROKERS=localhost:39092
NEXO_KAFKA_TLS_CA=$directory/certs/ca.crt"
echo "$variables"
if [[ -n "${GITHUB_ENV:-}" ]]; then echo "$variables" >> "$GITHUB_ENV"; fi
