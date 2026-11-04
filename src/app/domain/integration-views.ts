/** Readable views of Git, MCP and OAuth results. */

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  files: { path: string; change: string }[];
}
const changes: Record<string, string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  U: 'conflict',
};
/** Parses `git status --porcelain=v2 --branch`. */
export function parseGitStatus(stdout: string): GitStatus {
  const status: GitStatus = { branch: '', ahead: 0, behind: 0, files: [] };
  for (const line of stdout.split('\n').map((l) => l.trimEnd())) {
    if (line.startsWith('# branch.head ')) status.branch = line.slice('# branch.head '.length);
    else if (line.startsWith('# branch.ab ')) {
      const [ahead, behind] = line.slice('# branch.ab '.length).split(' ');
      status.ahead = Math.abs(Number(ahead) || 0);
      status.behind = Math.abs(Number(behind) || 0);
    } else if (line.startsWith('? '))
      status.files.push({ path: line.slice(2), change: 'untracked' });
    else if (/^[12u] /.test(line)) {
      const fields = line.split(' ');
      const xy = fields[1] ?? '..';
      const code = [...xy].find((c) => c !== '.') ?? 'M';
      // Ordinary entries have 9 fields before the path; renames have 10, with "path\torig".
      const path = fields
        .slice(line.startsWith('2 ') ? 9 : line.startsWith('u ') ? 10 : 8)
        .join(' ');
      status.files.push({ path: path.split('\t')[0], change: changes[code] ?? 'modified' });
    }
  }
  return status;
}

export interface McpView {
  status: number;
  session?: string;
  tools: { name: string; description: string }[];
  texts: string[];
  error?: string;
}
/** Tools, text content and errors of an MCP JSON-RPC answer (JSON or SSE messages). */
export function mcpView(result: unknown): McpView {
  const value = (result ?? {}) as { status?: number; sessionId?: string; result?: unknown };
  const messages = (Array.isArray(value.result) ? value.result : [value.result]) as {
    result?: { tools?: { name?: string; description?: string }[]; content?: { text?: string }[] };
    error?: { message?: string };
  }[];
  const view: McpView = { status: value.status ?? 0, tools: [], texts: [] };
  if (value.sessionId) view.session = value.sessionId;
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    for (const tool of message.result?.tools ?? [])
      view.tools.push({
        name: String(tool.name ?? ''),
        description: String(tool.description ?? ''),
      });
    for (const content of message.result?.content ?? [])
      if (typeof content.text === 'string') view.texts.push(content.text);
    if (message.error?.message) view.error = message.error.message;
  }
  return view;
}

const secretFields = /token|secret|password|code/i;
/** OAuth token response fields with credentials shortened for display. */
export function tokenView(result: { status: number; body: Record<string, unknown> }) {
  return {
    status: result.status,
    fields: Object.entries(result.body ?? {}).map(([key, raw]) => {
      const value = typeof raw === 'string' ? raw : JSON.stringify(raw);
      return {
        key,
        value:
          secretFields.test(key) && value.length > 12
            ? `${value.slice(0, 6)}…${value.slice(-4)}`
            : value,
      };
    }),
  };
}
