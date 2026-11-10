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

/** A resource of an MCP server, or a template for several. */
export interface McpResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  template: boolean;
}
export interface McpPromptArgument {
  name: string;
  description: string;
  required: boolean;
}
export interface McpPrompt {
  name: string;
  description: string;
  arguments: McpPromptArgument[];
}
/** What `resources/read` returned for one URI. */
export interface McpContent {
  uri: string;
  mimeType: string;
  text: string;
}
/** A message of a prompt from `prompts/get`, with the resource it embeds, if any. */
export interface McpMessage {
  role: string;
  text: string;
  uri?: string;
}
export interface McpView {
  status: number;
  session?: string;
  tools: { name: string; description: string }[];
  texts: string[];
  resources: McpResource[];
  prompts: McpPrompt[];
  contents: McpContent[];
  messages: McpMessage[];
  error?: string;
}

type Loose = Record<string, unknown>;
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const list = (value: unknown): Loose[] =>
  Array.isArray(value)
    ? value.filter((item): item is Loose => !!item && typeof item === 'object')
    : [];
/** A content block as text: its text, or the text of the resource it embeds. */
function contentText(content: Loose): { text: string; uri?: string } {
  const resource = (content['resource'] ?? {}) as Loose;
  if (content['type'] === 'resource')
    return {
      text: text(resource['text']) || (resource['blob'] ? '(binary)' : ''),
      uri: text(resource['uri']),
    };
  return { text: text(content['text']) };
}

/**
 * Tools, resources, prompts, read contents, prompt messages and errors of an MCP JSON-RPC
 * answer (JSON or SSE messages).
 */
export function mcpView(result: unknown): McpView {
  const value = (result ?? {}) as { status?: number; sessionId?: string; result?: unknown };
  const messages = list(Array.isArray(value.result) ? value.result : [value.result]);
  const view: McpView = {
    status: value.status ?? 0,
    tools: [],
    texts: [],
    resources: [],
    prompts: [],
    contents: [],
    messages: [],
  };
  if (value.sessionId) view.session = value.sessionId;
  for (const message of messages) {
    const answer = (message['result'] ?? {}) as Loose;
    for (const tool of list(answer['tools']))
      view.tools.push({ name: text(tool['name']), description: text(tool['description']) });
    for (const content of list(answer['content'])) {
      const shown = contentText(content).text;
      if (shown) view.texts.push(shown);
    }
    for (const [key, template] of [
      ['resources', false],
      ['resourceTemplates', true],
    ] as const)
      for (const resource of list(answer[key]))
        view.resources.push({
          uri: text(resource[template ? 'uriTemplate' : 'uri']),
          name: text(resource['title']) || text(resource['name']),
          description: text(resource['description']),
          mimeType: text(resource['mimeType']),
          template,
        });
    for (const prompt of list(answer['prompts']))
      view.prompts.push({
        name: text(prompt['name']),
        description: text(prompt['description']) || text(prompt['title']),
        arguments: list(prompt['arguments']).map((argument) => ({
          name: text(argument['name']),
          description: text(argument['description']),
          required: argument['required'] === true,
        })),
      });
    for (const content of list(answer['contents']))
      view.contents.push({
        uri: text(content['uri']),
        mimeType: text(content['mimeType']),
        text: text(content['text']) || (content['blob'] ? '(binary)' : ''),
      });
    for (const prompt of list(answer['messages'])) {
      const { text: body, uri } = contentText((prompt['content'] ?? {}) as Loose);
      view.messages.push({ role: text(prompt['role']), text: body, ...(uri ? { uri } : {}) });
    }
    const error = (message['error'] ?? {}) as Loose;
    if (text(error['message'])) view.error = text(error['message']);
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
