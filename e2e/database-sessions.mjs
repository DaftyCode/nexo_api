// The database sessions a test opens, closed on the server when it ends, as the app does
// when its page goes: the tests share a server, which keeps a limited number of them open.

/** The sessions the pages of a browser context open (`db.connect`): workspace by name. */
export function recordSessions(context) {
  const opened = new Map();
  context.on('request', (request) => {
    if (request.method() !== 'POST' || !request.url().endsWith('/api/execute/db.connect')) return;
    const { session, workspace } = request.postDataJSON() ?? {};
    if (session) opened.set(session, workspace);
  });
  return opened;
}

/** Closes database sessions on the server at `base`, with its per-run token. */
export async function closeSessions(base, token, sessions) {
  for (const [session, workspace] of sessions)
    await fetch(`${base}/api/execute/db.disconnect`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ session, ...(workspace ? { workspace } : {}) }),
    }).catch(() => undefined);
}
