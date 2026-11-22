/**
 * The commands of Redis the console completes, with their syntax as the documentation writes
 * it: the most used ones of each group. Any other command can still be typed.
 */
export interface RedisCommand {
  name: string;
  syntax: string;
}

const COMMANDS: readonly [string, string][] = [
  ['APPEND', 'key value'],
  ['BITCOUNT', 'key [start end [BYTE | BIT]]'],
  ['CLIENT LIST', '[TYPE type] [ID client-id ...]'],
  ['CLIENT KILL', 'ID client-id'],
  ['CONFIG GET', 'parameter [parameter ...]'],
  ['CONFIG SET', 'parameter value [parameter value ...]'],
  ['COPY', 'source destination [DB destination-db] [REPLACE]'],
  ['DBSIZE', ''],
  ['DECR', 'key'],
  ['DECRBY', 'key decrement'],
  ['DEL', 'key [key ...]'],
  ['DUMP', 'key'],
  ['ECHO', 'message'],
  ['EVAL', 'script numkeys [key ...] [arg ...]'],
  ['EXISTS', 'key [key ...]'],
  ['EXPIRE', 'key seconds [NX | XX | GT | LT]'],
  ['EXPIRETIME', 'key'],
  ['FLUSHALL', '[ASYNC | SYNC]'],
  ['FLUSHDB', '[ASYNC | SYNC]'],
  ['GEOADD', 'key longitude latitude member [longitude latitude member ...]'],
  ['GEOSEARCH', 'key FROMMEMBER member | FROMLONLAT lon lat BYRADIUS radius M | KM'],
  ['GET', 'key'],
  ['GETDEL', 'key'],
  ['GETEX', 'key [EX seconds | PX milliseconds | PERSIST]'],
  ['GETRANGE', 'key start end'],
  ['HDEL', 'key field [field ...]'],
  ['HEXISTS', 'key field'],
  ['HGET', 'key field'],
  ['HGETALL', 'key'],
  ['HINCRBY', 'key field increment'],
  ['HKEYS', 'key'],
  ['HLEN', 'key'],
  ['HMGET', 'key field [field ...]'],
  ['HSCAN', 'key cursor [MATCH pattern] [COUNT count]'],
  ['HSET', 'key field value [field value ...]'],
  ['HVALS', 'key'],
  ['INCR', 'key'],
  ['INCRBY', 'key increment'],
  ['INFO', '[section ...]'],
  ['JSON.GET', 'key [path ...]'],
  ['JSON.SET', 'key path value [NX | XX]'],
  ['LINDEX', 'key index'],
  ['LINSERT', 'key BEFORE | AFTER pivot element'],
  ['LLEN', 'key'],
  ['LPOP', 'key [count]'],
  ['LPUSH', 'key element [element ...]'],
  ['LRANGE', 'key start stop'],
  ['LREM', 'key count element'],
  ['LSET', 'key index element'],
  ['LTRIM', 'key start stop'],
  ['MEMORY USAGE', 'key [SAMPLES count]'],
  ['MGET', 'key [key ...]'],
  ['MSET', 'key value [key value ...]'],
  ['OBJECT ENCODING', 'key'],
  ['PERSIST', 'key'],
  ['PEXPIRE', 'key milliseconds'],
  ['PFADD', 'key [element ...]'],
  ['PFCOUNT', 'key [key ...]'],
  ['PING', '[message]'],
  ['PTTL', 'key'],
  ['PUBLISH', 'channel message'],
  ['PUBSUB CHANNELS', '[pattern]'],
  ['RANDOMKEY', ''],
  ['RENAME', 'key newkey'],
  ['RENAMENX', 'key newkey'],
  ['RPOP', 'key [count]'],
  ['RPUSH', 'key element [element ...]'],
  ['SADD', 'key member [member ...]'],
  ['SCAN', 'cursor [MATCH pattern] [COUNT count] [TYPE type]'],
  ['SCARD', 'key'],
  ['SDIFF', 'key [key ...]'],
  ['SELECT', 'index'],
  ['SET', 'key value [NX | XX] [GET] [EX seconds | PX milliseconds | KEEPTTL]'],
  ['SETNX', 'key value'],
  ['SINTER', 'key [key ...]'],
  ['SISMEMBER', 'key member'],
  ['SLOWLOG GET', '[count]'],
  ['SMEMBERS', 'key'],
  ['SREM', 'key member [member ...]'],
  ['SSCAN', 'key cursor [MATCH pattern] [COUNT count]'],
  ['STRLEN', 'key'],
  ['SUNION', 'key [key ...]'],
  ['TIME', ''],
  ['TTL', 'key'],
  ['TYPE', 'key'],
  ['UNLINK', 'key [key ...]'],
  ['XADD', 'key [MAXLEN [= | ~] threshold] * | id field value [field value ...]'],
  ['XDEL', 'key id [id ...]'],
  ['XINFO STREAM', 'key [FULL [COUNT count]]'],
  ['XLEN', 'key'],
  ['XRANGE', 'key start end [COUNT count]'],
  ['XREVRANGE', 'key end start [COUNT count]'],
  ['ZADD', 'key [NX | XX] [GT | LT] [CH] [INCR] score member [score member ...]'],
  ['ZCARD', 'key'],
  ['ZCOUNT', 'key min max'],
  ['ZINCRBY', 'key increment member'],
  ['ZRANGE', 'key start stop [BYSCORE | BYLEX] [REV] [LIMIT offset count] [WITHSCORES]'],
  ['ZRANK', 'key member'],
  ['ZREM', 'key member [member ...]'],
  ['ZSCAN', 'key cursor [MATCH pattern] [COUNT count]'],
  ['ZSCORE', 'key member'],
];

export const REDIS_COMMANDS: readonly RedisCommand[] = COMMANDS.map(([name, syntax]) => ({
  name,
  syntax,
}));

/** The commands a line starts to name, at most `limit`; nothing once its first word is done. */
export function commandHints(line: string, limit = 8): RedisCommand[] {
  const typed = line.trimStart().toUpperCase();
  if (!typed || /\s{2,}|\S\s+\S+\s/.test(typed)) return [];
  return REDIS_COMMANDS.filter(
    (command) => command.name.startsWith(typed) && command.name !== typed,
  ).slice(0, limit);
}

/** The syntax of the command a line names, to show while it is written. */
export function commandSyntax(line: string): RedisCommand | undefined {
  const words = line.trim().toUpperCase().split(/\s+/);
  return (
    REDIS_COMMANDS.find((command) => command.name === `${words[0]} ${words[1] ?? ''}`.trim()) ??
    REDIS_COMMANDS.find((command) => command.name === words[0])
  );
}
