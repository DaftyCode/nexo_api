// What the contract tests of the databases of the modules share: saving connections, opening
// their sessions and running statements as the SQL editor does, on the server the test
// starts (read when each call is made).
import assert from 'node:assert/strict';

export function dbClient(current) {
  const save = (id, value) =>
    current().api('PUT', '/documents', {
      id,
      workspace_id: 'local',
      kind: 'connection',
      name: id,
      revision: 0,
      updated_at: 0,
      value,
    });
  const connect = (id, session, host = '') =>
    current().execute('db.connect', { connectionId: id, session, variables: { host } });
  const execute = (session, sql, confirmName) =>
    current().api('POST', '/execute/db.execute', {
      workspace: 'local',
      session,
      statement: `q-${Math.random()}`,
      sql,
      confirm: true,
      ...(confirmName ? { confirmName } : {}),
    });
  const run = async (session, sql) => {
    let answer = await execute(session, sql);
    // A DROP is confirmed by typing the name Nexo asks for, as the SQL editor asks.
    const asked = /confirm: (.+)$/.exec(answer.body?.error ?? '')?.[1];
    if (answer.status !== 200 && asked) answer = await execute(session, sql, asked);
    assert.equal(
      answer.status,
      200,
      `${sql}
${JSON.stringify(answer.body)}`,
    );
    return answer.body;
  };
  const call = (operation, payload) =>
    current().api('POST', `/execute/${operation}`, { workspace: 'local', ...payload });
  const ok = async (operation, payload) => {
    const answer = await call(operation, payload);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    return answer.body;
  };
  return { save, connect, run, call, ok };
}
