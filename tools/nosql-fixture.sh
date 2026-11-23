#!/usr/bin/env bash
# Starts the engines that are not SQL for their driver and contract tests, each one apart
# because they start slowly:
#   29042 Apache Cassandra 5 (no authentication), with tools/nosql-fixture-seed-cassandra.cql
#   26379 Redis 7.4 and 26380 Valkey 8, with an ACL user, a key of each type and 100 000 keys
#   29200 Elasticsearch 8 (user elastic) and 29201 OpenSearch 2 (user admin, TLS with its demo
#         certificate), each one with the index shop
#   28047 Apache Drill 1.21 embedded, with its sample files and a plugin that has a password
#   21001 Apache Hive 4 (HiveServer2 in HTTP mode, path /cliservice, user hive)
#   20800 Apache Ignite 3.1, open, with the schema SHOP (a table of every type, 100 000 rows),
#         and 20801 another node with TLS (its own certificate) and the user ignite
# Prints the NEXO_* variables the tests read, and adds them to $GITHUB_ENV in CI.
# Usage: tools/nosql-fixture.sh start [cassandra redis elastic drill hive ignite …] | stop
set -euo pipefail
export MSYS_NO_PATHCONV=1

cassandra=cassandra:5.0
redis=redis:7.4-alpine
valkey=valkey/valkey:8.1-alpine
elastic=elasticsearch:8.17.4
opensearch=opensearchproject/opensearch:2.19.1
drill=apache/drill:1.21.2
hive=apache/hive:4.0.1
ignite=apacheignite/ignite:3.1.0
names=(nexo-nosql-cassandra nexo-nosql-redis nexo-nosql-valkey nexo-nosql-elastic nexo-nosql-opensearch nexo-nosql-drill nexo-nosql-hive nexo-nosql-ignite nexo-nosql-ignite-secure)
password=nexo-redis-Secret1
search_password=Nexo-Search-Secret1
ignite_password=Nexo-Ignite-Secret1

if [[ "${1:-start}" == "stop" ]]; then
  docker rm -f "${names[@]}" >/dev/null 2>&1 || true
  exit 0
fi
shift || true
wanted=("$@")
[[ ${#wanted[@]} -eq 0 ]] && wanted=(cassandra redis elastic drill hive ignite)
has() { [[ " ${wanted[*]} " == *" $1 "* ]]; }

variables=""
if has cassandra; then
  docker rm -f nexo-nosql-cassandra >/dev/null 2>&1 || true
  docker pull -q "$cassandra" >/dev/null
  docker run -d --name nexo-nosql-cassandra -p 29042:9042 \
    -e MAX_HEAP_SIZE=512M -e HEAP_NEWSIZE=128M -e CASSANDRA_CLUSTER_NAME=nexo \
    -e CASSANDRA_DC=dc1 -e CASSANDRA_ENDPOINT_SNITCH=GossipingPropertyFileSnitch \
    "$cassandra" >/dev/null
  seed="$(cd "$(dirname "$0")" && pwd)/nosql-fixture-seed-cassandra.cql"
  started=false
  for _ in $(seq 1 120); do
    if docker exec nexo-nosql-cassandra cqlsh -e "DESCRIBE KEYSPACES" >/dev/null 2>&1; then
      started=true
      break
    fi
    sleep 2
  done
  if [[ "$started" != true ]]; then
    docker logs --tail 40 nexo-nosql-cassandra >&2 || true
    echo "Cassandra did not start" >&2
    exit 1
  fi
  # Through standard input: a path of Git Bash is not one Docker on Windows reads.
  docker exec -i nexo-nosql-cassandra sh -c 'cat > /tmp/seed.cql' < "$seed"
  docker exec nexo-nosql-cassandra cqlsh -f /tmp/seed.cql
  variables="${variables}NEXO_CASSANDRA_HOST=127.0.0.1
NEXO_CASSANDRA_PORT=29042
NEXO_CASSANDRA_DC=dc1
"
fi
# A key of each type (one of them binary), and 100 000 more to page through.
seed_redis() {
  local container=$1 cli=$2
  local run=(docker exec "$container" "$cli" --user nexo --pass "$password" --no-auth-warning)
  "${run[@]}" FLUSHALL >/dev/null
  "${run[@]}" SET user:1:name "Ana" >/dev/null
  "${run[@]}" EVAL "redis.call('SET', KEYS[1], string.char(255, 0) .. 'bin') return 1" 1 bin:1 >/dev/null
  "${run[@]}" RPUSH queue:jobs a b c >/dev/null
  "${run[@]}" SADD tags red green >/dev/null
  "${run[@]}" ZADD scores 1.5 ana 3 luis >/dev/null
  "${run[@]}" HSET user:1 name Ana city Lima >/dev/null
  "${run[@]}" XADD events '*' kind login user ana >/dev/null
  "${run[@]}" SET session:1 x PX 3600000 >/dev/null
  "${run[@]}" EVAL "for i = 1, 100000 do redis.call('SET', 'bulk:' .. i, i) end return 1" 0 >/dev/null
}
start_redis() {
  local name=$1 image=$2 port=$3 server=$4 cli=$5
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker pull -q "$image" >/dev/null
  # The default user is off: only the ACL user nexo, with its password, gets in.
  docker run -d --name "$name" -p "$port:6379" "$image" "$server"     --user default off --user nexo on ">$password" '~*' '&*' +@all >/dev/null
  for _ in $(seq 1 60); do
    if docker exec "$name" "$cli" --user nexo --pass "$password" --no-auth-warning PING 2>/dev/null | grep -q PONG; then
      seed_redis "$name" "$cli"
      return 0
    fi
    sleep 1
  done
  docker logs --tail 40 "$name" >&2 || true
  echo "$name did not start" >&2
  exit 1
}
if has redis; then
  start_redis nexo-nosql-redis "$redis" 26379 redis-server redis-cli
  start_redis nexo-nosql-valkey "$valkey" 26380 valkey-server valkey-cli
  variables="${variables}NEXO_REDIS_HOST=127.0.0.1
NEXO_REDIS_PORT=26379
NEXO_VALKEY_PORT=26380
NEXO_REDIS_USER=nexo
NEXO_REDIS_PASSWORD=$password
"
fi
# The index shop: a text with its keyword, a number, an object, a date and a point.
seed_search() {
  local container=$1 base=$2 user=$3
  local call=(docker exec "$container" curl -sk -u "$user:$search_password" -H 'Content-Type: application/json')
  "${call[@]}" -X DELETE "$base/shop" >/dev/null
  "${call[@]}" -X PUT "$base/shop" -d '{"mappings":{"properties":{"name":{"type":"text","fields":{"keyword":{"type":"keyword"}}},"price":{"type":"double"},"stock":{"type":"integer"},"user":{"properties":{"address":{"properties":{"city":{"type":"keyword"}}}}},"at":{"type":"date"},"place":{"type":"geo_point"}}}}' >/dev/null
  for doc in \
    '{"name":"Lamp","price":19.5,"stock":3,"user":{"address":{"city":"Lima"}},"at":"2024-01-01T10:00:00Z","place":{"lat":-12.04,"lon":-77.03}}' \
    '{"name":"Desk","price":120,"stock":1,"user":{"address":{"city":"Quito"}},"at":"2024-02-01T10:00:00Z","place":{"lat":-0.18,"lon":-78.47}}' \
    '{"name":"Chair","price":45,"stock":7,"user":{"address":{"city":"Lima"}},"at":"2024-03-01T10:00:00Z","place":{"lat":-12.1,"lon":-77.0}}'; do
    "${call[@]}" -X POST "$base/shop/_doc" -d "$doc" >/dev/null
  done
  "${call[@]}" -X POST "$base/shop/_refresh" >/dev/null
}
start_search() {
  local name=$1 image=$2 port=$3 base=$4 user=$5
  shift 5
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker pull -q "$image" >/dev/null
  docker run -d --name "$name" -p "$port:9200" -e discovery.type=single-node "$@" "$image" >/dev/null
  for _ in $(seq 1 120); do
    if docker exec "$name" curl -sk -u "$user:$search_password" "$base/_cluster/health?wait_for_status=yellow&timeout=1s" 2>/dev/null | grep -q '"status"'; then
      seed_search "$name" "$base" "$user"
      return 0
    fi
    sleep 2
  done
  docker logs --tail 40 "$name" >&2 || true
  echo "$name did not start" >&2
  exit 1
}
if has elastic; then
  start_search nexo-nosql-elastic "$elastic" 29200 http://localhost:9200 elastic \
    -e xpack.security.enabled=true -e xpack.security.http.ssl.enabled=false \
    -e "ELASTIC_PASSWORD=$search_password" -e "ES_JAVA_OPTS=-Xms512m -Xmx512m"
  start_search nexo-nosql-opensearch "$opensearch" 29201 https://localhost:9200 admin \
    -e "OPENSEARCH_INITIAL_ADMIN_PASSWORD=$search_password" -e "OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m"
  variables="${variables}NEXO_ELASTIC_HOST=127.0.0.1
NEXO_ELASTIC_PORT=29200
NEXO_ELASTIC_USER=elastic
NEXO_OPENSEARCH_PORT=29201
NEXO_OPENSEARCH_USER=admin
NEXO_SEARCH_PASSWORD=$search_password
"
fi
if has drill; then
  docker rm -f nexo-nosql-drill >/dev/null 2>&1 || true
  docker pull -q "$drill" >/dev/null
  # Embedded Drill keeps its shell open only with a terminal.
  docker run -d -t --name nexo-nosql-drill -p 28047:8047 "$drill" >/dev/null
  started=false
  for _ in $(seq 1 90); do
    if docker exec nexo-nosql-drill curl -s http://localhost:8047/status 2>/dev/null | grep -qi running; then
      started=true
      break
    fi
    sleep 2
  done
  if [[ "$started" != true ]]; then
    docker logs --tail 40 nexo-nosql-drill >&2 || true
    echo "Drill did not start" >&2
    exit 1
  fi
  # A disabled plugin with a password, to see that Nexo never shows it.
  docker exec nexo-nosql-drill curl -s -X POST -H 'Content-Type: application/json' \
    http://localhost:8047/storage/secretmongo.json \
    -d '{"name":"secretmongo","config":{"type":"mongo","connection":"mongodb://ana:s3cret-pass@db:27017/","enabled":false}}' >/dev/null
  variables="${variables}NEXO_DRILL_HOST=127.0.0.1
NEXO_DRILL_PORT=28047
"
fi
if has hive; then
  docker rm -f nexo-nosql-hive >/dev/null 2>&1 || true
  docker pull -q "$hive" >/dev/null
  # HiveServer2 in HTTP mode, without authentication: it takes the user of Basic
  # authentication and any password, as the driver sends them.
  docker run -d --name nexo-nosql-hive -p 21001:10001 -e SERVICE_NAME=hiveserver2     -e SERVICE_OPTS="-Dhive.server2.transport.mode=http -Dhive.server2.thrift.http.port=10001"     "$hive" >/dev/null
  started=false
  for _ in $(seq 1 120); do
    # 401 without credentials: the Thrift servlet answers.
    if [[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:21001/cliservice)" == "401" ]]; then
      started=true
      break
    fi
    sleep 2
  done
  if [[ "$started" != true ]]; then
    docker logs --tail 40 nexo-nosql-hive >&2 || true
    echo "Hive did not start" >&2
    exit 1
  fi
  variables="${variables}NEXO_HIVE_HOST=127.0.0.1
NEXO_HIVE_PORT=21001
NEXO_HIVE_USER=hive
NEXO_HIVE_PASSWORD=hive-secret
"
fi
# Ignite 3: a node answers its REST API (port 10300) first, then waits for the cluster to be
# initialized. Its client port is 10800.
ignite_state() {
  local port=$1 wanted=$2 credentials=${3:-}
  for _ in $(seq 1 120); do
    local state
    state="$(curl -s ${credentials:+-u "$credentials"} "http://127.0.0.1:$port/management/v1/node/state" || true)"
    [[ "$state" == *"$wanted"* ]] && return 0
    sleep 2
  done
  return 1
}
ignite_sql() {
  docker exec nexo-nosql-ignite /opt/ignite3cli/bin/ignite3 sql --plain \
    --jdbc-url=jdbc:ignite:thin://127.0.0.1:10800 "$1" 2>&1 | grep -v '^WARNING' >&2
}
if has ignite; then
  docker rm -f nexo-nosql-ignite nexo-nosql-ignite-secure >/dev/null 2>&1 || true
  docker pull -q "$ignite" >/dev/null
  for node in "nexo-nosql-ignite 20800 20300" "nexo-nosql-ignite-secure 20801 20301"; do
    read -r name client rest <<< "$node"
    docker run -d --name "$name" -p "$client:10800" -p "$rest:10300" \
      -e JVM_MAX_MEM=1g -e JVM_MIN_MEM=512m "$ignite" >/dev/null
  done
  for port in 20300 20301; do
    if ! ignite_state "$port" STARTING; then
      docker logs --tail 40 nexo-nosql-ignite >&2 || true
      echo "Ignite did not start" >&2
      exit 1
    fi
  done
  # The secure node: a certificate of its own and TLS on its client port, before the cluster
  # is initialized with basic authentication.
  docker exec nexo-nosql-ignite-secure keytool -genkeypair -alias ignite -keyalg RSA \
    -keysize 2048 -validity 3650 -dname CN=localhost -ext SAN=dns:localhost,ip:127.0.0.1 \
    -storetype PKCS12 -keystore /opt/ignite/etc/keystore.p12 -storepass nexo-keystore >/dev/null 2>&1
  docker exec -i nexo-nosql-ignite-secure sh -c 'cat > /opt/ignite/etc/ignite-config.conf' <<'CONF'
ignite {
  network {
    nodeFinder { netClusterNodes = ["localhost:3344"], type = STATIC }
    port = 3344
  }
  clientConnector.ssl {
    enabled = true
    keyStore { type = PKCS12, path = "/opt/ignite/etc/keystore.p12", password = "nexo-keystore" }
  }
}
CONF
  docker restart nexo-nosql-ignite-secure >/dev/null
  ignite_state 20301 STARTING
  curl -sf -X POST -H 'Content-Type: application/json' \
    http://127.0.0.1:20300/management/v1/cluster/init \
    -d '{"metaStorageNodes":["defaultNode"],"clusterName":"nexo"}' >/dev/null
  security="ignite.security { enabled = true, authentication.providers.default = { type = basic, users = [{ username = ignite, password = \\\"$ignite_password\\\" }] } }"
  curl -sf -X POST -H 'Content-Type: application/json' \
    http://127.0.0.1:20301/management/v1/cluster/init \
    -d "{\"metaStorageNodes\":[\"defaultNode\"],\"clusterName\":\"nexo-secure\",\"clusterConfiguration\":\"$security\"}" >/dev/null
  if ! ignite_state 20300 STARTED || ! ignite_state 20301 STARTED "ignite:$ignite_password"; then
    docker logs --tail 40 nexo-nosql-ignite-secure >&2 || true
    echo "The Ignite cluster did not start" >&2
    exit 1
  fi
  ignite_sql "CREATE ZONE IF NOT EXISTS SHOP_ZONE (PARTITIONS 4, REPLICAS 1) STORAGE PROFILES ['default']"
  ignite_sql "CREATE SCHEMA IF NOT EXISTS SHOP"
  ignite_sql "CREATE TABLE SHOP.ITEMS (ID INT, REGION VARCHAR(20), NAME VARCHAR(100) NOT NULL, \
PRICE DECIMAL(10,2), STOCK BIGINT DEFAULT 0, ACTIVE BOOLEAN, ADDED DATE, OPENS TIME(3), \
UPDATED TIMESTAMP(6), SEEN TIMESTAMP WITH LOCAL TIME ZONE, CODE UUID, PHOTO VARBINARY(64), \
RATING REAL, SCORE DOUBLE, SMALL SMALLINT, TINY TINYINT, PRIMARY KEY (ID, REGION)) \
COLOCATE BY (REGION) ZONE SHOP_ZONE"
  ignite_sql "CREATE INDEX ITEMS_NAME ON SHOP.ITEMS (NAME DESC, PRICE)"
  ignite_sql "CREATE INDEX ITEMS_CODE ON SHOP.ITEMS USING HASH (CODE)"
  ignite_sql "INSERT INTO SHOP.ITEMS (ID, REGION, NAME, PRICE, STOCK, ACTIVE, ADDED, OPENS, \
UPDATED, SEEN, CODE, PHOTO, RATING, SCORE, SMALL, TINY) SELECT x, CASE WHEN MOD(x, 2) = 0 \
THEN 'north' ELSE 'south' END, 'Item ' || CAST(x AS VARCHAR), CAST(x AS DECIMAL(10,2)) / 100, \
x * 3, MOD(x, 3) = 0, DATE '2024-01-01' + CAST(MOD(x, 365) AS INTEGER) * INTERVAL '1' DAY, \
TIME '08:30:00.125', TIMESTAMP '2024-01-02 03:04:05.123', \
TIMESTAMP WITH LOCAL TIME ZONE '2024-01-02 03:04:05', RAND_UUID(), X'CAFE', 0.5, 0.25, 7, -3 \
FROM TABLE(SYSTEM_RANGE(1, 100000))"
  variables="${variables}NEXO_IGNITE_HOST=127.0.0.1
NEXO_IGNITE_PORT=20800
NEXO_IGNITE_SECURE_PORT=20801
NEXO_IGNITE_USER=ignite
NEXO_IGNITE_PASSWORD=$ignite_password
"
fi
printf '%s' "$variables"
if [[ -n "${GITHUB_ENV:-}" ]]; then printf '%s' "$variables" >> "$GITHUB_ENV"; fi
